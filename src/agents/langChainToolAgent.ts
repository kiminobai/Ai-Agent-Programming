/**
 * 学习点：这是 LangChain 版 Tool Agent。
 *
 * 它把模型、System Prompt、Tools、短期记忆和 SQLite checkpointer
 * 组装到 createAgent 里，形成标准 Agent Loop。
 */
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import {
  createAgent,
  humanInTheLoopMiddleware,
  summarizationMiddleware
} from "langchain";
import { Command } from "@langchain/langgraph";
import { sqliteCheckpointer } from "../db/sqlite";
import { langChainTools } from "../tools/langchain";
import { ProviderId, ReasoningEffort } from "../types";
import type { RoleWorkflowAgent } from "../workflows-agents";
import { AgentContext, AgentContextSchema } from "./agentContext";
import { createAgentWorkflowGraph } from "./agentWorkflowGraph";
import { dynamicMemoryPromptMiddleware } from "./dynamicMemoryPromptMiddleware";
import { ToolMemoryState } from "./toolMemoryState";

// 学习点：ToolAgentMessage 是项目自己的简单消息格式。
// 进入 LangChain 前，会再转换成 HumanMessage / AIMessage。
export interface ToolAgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LangChainToolAgentOptions {
  providerId: ProviderId;
  apiKey: string;
  apiUrl: string;
  modelId: string;
  systemPrompt: string;
  roleWorkflow?: RoleWorkflowAgent;
  reasoningEffort?: ReasoningEffort;
}

export class LangChainToolAgent {
  private static readonly SUMMARY_TRIGGER_TOKENS = 8_000;
  private static readonly SUMMARY_KEEP_MESSAGES = 12;

  private readonly agent;
  private readonly workflow;
  private readonly migratedThreads = new Set<string>();

  constructor(options: LangChainToolAgentOptions) {
    // 学习点：ChatOpenAI 也可以连接 DeepSeek/SiliconFlow 这类 OpenAI-compatible 接口。
    // 关键是 apiKey、model 和 baseURL。
    const model = new ChatOpenAI({
      apiKey: options.apiKey,
      model: options.modelId,
      temperature: options.providerId === "moonshot" ? 1 : 0,
      streaming: true,
      streamUsage: false,
      reasoning:
        options.providerId === "openai"
          ? { effort: options.reasoningEffort }
          : undefined,
      configuration: {
        baseURL: this.getBaseUrl(options.apiUrl)
      }
    });

    // 学习点：短期记忆太长会超上下文。
    // summarizationMiddleware 会在消息太多时，把旧消息压缩成摘要。
    const memorySummarizer = summarizationMiddleware({
      model,
      trigger: {
        tokens: LangChainToolAgent.SUMMARY_TRIGGER_TOKENS
      },
      keep: {
        messages: LangChainToolAgent.SUMMARY_KEEP_MESSAGES
      }
    });

    // 学习点：只对会修改长期数据的工具启用人工审批。
    // 天气、计算、时间和文档检索都是只读操作，仍然自动执行。
    const approvalMiddleware = humanInTheLoopMiddleware({
      interruptOn: {
        remember_preference: {
          allowedDecisions: ["approve", "reject"],
          description: "Agent 准备把用户偏好写入长期记忆。"
        }
      },
      descriptionPrefix: "此操作需要用户确认"
    });

    this.agent = createAgent({
      model,
      tools: langChainTools,
      systemPrompt: options.systemPrompt,
      stateSchema: ToolMemoryState,
      contextSchema: AgentContextSchema,
      // 学习点：每次模型调用前，动态拼接长期记忆、短期工具上下文和上传文档状态。
      middleware: [
        memorySummarizer,
        dynamicMemoryPromptMiddleware,
        approvalMiddleware
      ]
    });

    // 学习点：外层 StateGraph 管项目流程，内层 createAgent 管模型与工具循环。
    // 这样可以看到明确的 Node/Edge，同时保留原有 Streaming 和 Memory 能力。
    this.workflow = createAgentWorkflowGraph(this.agent, {
      roleId: options.roleWorkflow?.roleId ?? "base-agent",
      workflowId: options.roleWorkflow?.workflowId ?? "base-agent-workflow",
      checkpointer: sqliteCheckpointer
    });
  }

  async invoke(
    messages: ToolAgentMessage[],
    threadId: string,
    userId: string
  ): Promise<string> {
    await this.restoreLegacySubgraphMessages(threadId);
    const pendingApproval = await this.getPendingApproval(threadId);
    if (pendingApproval) {
      const decision = this.parseApprovalDecision(messages);
      if (!decision) {
        return this.formatApprovalPrompt(pendingApproval);
      }

      const resumed = await this.workflow.invoke(
        this.createApprovalCommand(decision) as never,
        {
          configurable: { thread_id: threadId },
          context: this.createContext(userId, threadId)
        }
      );
      return this.extractFinalText(resumed.messages);
    }

    // 学习点：thread_id 是 LangGraph 短期记忆的分区键。
    // 同一个 thread 会继续使用同一份状态。
    const result = await this.workflow.invoke(
      { messages: this.toLangChainMessages(messages) },
      {
        configurable: { thread_id: threadId },
        context: this.createContext(userId, threadId)
      }
    );

    return this.extractFinalText(result.messages);
  }

  async stream(
    messages: ToolAgentMessage[],
    threadId: string,
    userId: string,
    onDelta: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    await this.restoreLegacySubgraphMessages(threadId);
    const pendingApproval = await this.getPendingApproval(threadId);
    const decision = pendingApproval
      ? this.parseApprovalDecision(messages)
      : null;

    if (pendingApproval && !decision) {
      const prompt = this.formatApprovalPrompt(pendingApproval);
      onDelta(prompt);
      return prompt;
    }

    // 学习点：streamMode=messages 会持续返回模型 token。
    // 工具节点输出会被过滤，避免把内部过程展示给用户。
    const runConfig = {
      // v2 返回标准 StreamEvent，并会包含 run_agent 子图里的模型 token 事件。
      version: "v2" as const,
      configurable: { thread_id: threadId },
      context: this.createContext(userId, threadId),
      // 浏览器点击“停止”后，AbortSignal 会一路传到模型和工具节点。
      signal
    };
    const runInput =
      pendingApproval && decision
        ? this.createApprovalCommand(decision)
        : { messages: this.toLangChainMessages(messages) };
    // Command.resume 与普通 State input 共用同一个入口，但两者的框架泛型不同。
    // 只在这里做边界适配，运行时仍由 LangGraph 判断是恢复还是新执行。
    const run = this.workflow.streamEvents(
      runInput as never,
      runConfig as never
    ) as unknown as AsyncIterable<unknown>;

    let fullText = "";

    // 学习点：模型位于外层工作流的 run_agent 子图中。
    // 直接迭代全部事件，才能收到子图产生的 on_chat_model_stream token。
    for await (const event of run) {
      const delta = this.extractStreamEventText(event, fullText);
      if (!delta) {
        continue;
      }

      fullText += delta;
      onDelta(delta);
    }

    if (!fullText) {
      const approvalAfterRun = await this.getPendingApproval(threadId);
      if (approvalAfterRun) {
        const prompt = this.formatApprovalPrompt(approvalAfterRun);
        onDelta(prompt);
        return prompt;
      }

      // 学习点：如果流里没有 token，就从 LangGraph state 里兜底找最后一条 AI 消息。
      fullText = await this.getLatestAssistantText(threadId);
      if (fullText) {
        onDelta(fullText);
      }
    }

    if (!fullText) {
      throw new Error("模型本轮没有返回可展示的文本内容，请重新发送。");
    }

    return fullText;
  }

  async hasThreadState(threadId: string): Promise<boolean> {
    await this.restoreLegacySubgraphMessages(threadId);
    const snapshot = (await (this.workflow as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<{
        values?: unknown;
      }>;
    }).getState({
      configurable: { thread_id: threadId }
    })) as {
      values?: unknown;
    };

    const messages = this.getStateMessages(snapshot.values);
    return messages.length > 0;
  }

  async getThreadMessages(threadId: string): Promise<ToolAgentMessage[]> {
    await this.restoreLegacySubgraphMessages(threadId);
    const snapshot = (await (this.workflow as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<{
        values?: unknown;
      }>;
    }).getState({
      configurable: { thread_id: threadId }
    })) as {
      values?: unknown;
    };

    const messages = this.getStateMessages(snapshot.values)
      .map((message) => this.toToolAgentMessage(message))
      .filter((message): message is ToolAgentMessage => Boolean(message));

    const pendingApproval = this.extractPendingApproval(snapshot);
    if (pendingApproval) {
      messages.push({
        role: "assistant",
        content: this.formatApprovalPrompt(pendingApproval)
      });
    }

    return messages;
  }

  /**
   * 学习点：旧版本把 SQLite checkpointer 挂在内层 createAgent 上，
   * 因此消息被写进 run_agent:* 子图命名空间，刷新时读取根状态就会看不到。
   *
   * 这里做一次兼容迁移：找到每个旧子图的最新检查点，将根状态缺少的消息
   * 按时间顺序、按消息 ID 去重后补回根工作流。旧数据不会被删除。
   */
  private async restoreLegacySubgraphMessages(threadId: string): Promise<void> {
    if (!threadId || this.migratedThreads.has(threadId)) {
      return;
    }

    const rootSnapshot = (await (this.workflow as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<{
        values?: unknown;
      }>;
    }).getState({
      configurable: { thread_id: threadId }
    })) as { values?: unknown };
    const rootMessages = this.getStateMessages(rootSnapshot.values);
    const knownMessageKeys = new Set(
      rootMessages.map((message) => this.getMessageIdentity(message))
    );

    const latestByNamespace = new Map<
      string,
      { timestamp: string; messages: BaseMessage[] }
    >();

    for await (const item of sqliteCheckpointer.list(
      { configurable: { thread_id: threadId } },
      { limit: 1_000 }
    )) {
      const configurable = item.config.configurable as {
        checkpoint_ns?: string;
      };
      const namespace = configurable.checkpoint_ns ?? "";
      if (
        !namespace.startsWith("run_agent:") &&
        !namespace.startsWith("runAgent:")
      ) {
        continue;
      }

      // list() 按新到旧返回；每个 namespace 只保留第一条，即该子图最终状态。
      if (latestByNamespace.has(namespace)) {
        continue;
      }

      const checkpoint = item.checkpoint as {
        ts?: string;
        channel_values?: unknown;
      };
      const messages = this.getStateMessages(checkpoint.channel_values);
      if (messages.length) {
        latestByNamespace.set(namespace, {
          timestamp: checkpoint.ts ?? "",
          messages
        });
      }
    }

    const missingMessages: BaseMessage[] = [];
    const legacyRuns = [...latestByNamespace.values()].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp)
    );

    for (const run of legacyRuns) {
      for (const message of run.messages) {
        const key = this.getMessageIdentity(message);
        if (knownMessageKeys.has(key)) {
          continue;
        }

        knownMessageKeys.add(key);
        missingMessages.push(message);
      }
    }

    if (missingMessages.length) {
      await (this.workflow as {
        updateState: (
          config: { configurable: { thread_id: string } },
          values: { messages: BaseMessage[] },
          asNode: string
        ) => Promise<unknown>;
      }).updateState(
        { configurable: { thread_id: threadId } },
        { messages: missingMessages },
        // 旧检查点可能记录旧版节点名；明确以新图的终点写入，避免节点名不兼容。
        "finish"
      );
    }

    this.migratedThreads.add(threadId);
  }

  private getMessageIdentity(message: BaseMessage): string {
    // LangChain 通常会为消息生成稳定 ID；兼容旧数据时再用类型和内容兜底。
    if (message.id) {
      return `id:${message.id}`;
    }

    return `${message.getType()}:${JSON.stringify(message.content)}`;
  }

  private async getPendingApproval(
    threadId: string
  ): Promise<{ descriptions: string[]; toolNames: string[] } | null> {
    const snapshot = await (this.workflow as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<unknown>;
    }).getState({
      configurable: { thread_id: threadId }
    });

    return this.extractPendingApproval(snapshot);
  }

  private extractPendingApproval(
    snapshot: unknown
  ): { descriptions: string[]; toolNames: string[] } | null {
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }

    const tasks = (snapshot as {
      tasks?: Array<{
        interrupts?: Array<{
          value?: {
            actionRequests?: Array<{ name?: string; description?: string }>;
            reviewConfigs?: Array<{ actionName?: string }>;
          };
        }>;
      }>;
    }).tasks;

    const interrupts = tasks?.flatMap((task) => task.interrupts ?? []) ?? [];
    if (!interrupts.length) {
      return null;
    }

    const descriptions = interrupts.flatMap((item) =>
      item.value?.actionRequests
        ?.map((request) => request.description?.trim() || "")
        .filter(Boolean) ?? []
    );
    const toolNames = interrupts.flatMap((item) => [
      ...(item.value?.actionRequests
        ?.map((request) => request.name?.trim() || "")
        .filter(Boolean) ?? []),
      ...(item.value?.reviewConfigs
        ?.map((config) => config.actionName?.trim() || "")
        .filter(Boolean) ?? [])
    ]);

    return {
      descriptions: [...new Set(descriptions)],
      toolNames: [...new Set(toolNames)]
    };
  }

  private parseApprovalDecision(
    messages: ToolAgentMessage[]
  ): "approve" | "reject" | null {
    const input = messages.at(-1)?.content.trim() ?? "";
    if (/^(批准|同意|确认|继续|approve|yes)$/i.test(input)) {
      return "approve";
    }
    if (/^(拒绝|取消|不同意|reject|no)$/i.test(input)) {
      return "reject";
    }
    return null;
  }

  private createApprovalCommand(decision: "approve" | "reject") {
    return new Command({
      resume: {
        decisions: [
          decision === "approve"
            ? { type: "approve" }
            : { type: "reject", message: "用户拒绝执行此操作。" }
        ]
      }
    });
  }

  private formatApprovalPrompt(approval: {
    descriptions: string[];
    toolNames: string[];
  }): string {
    const action =
      approval.descriptions[0] ||
      (approval.toolNames.length
        ? `执行工具：${approval.toolNames.join("、")}`
        : "执行一项会修改数据的操作");

    return `需要你的确认：${action}\n\n请回复“批准”继续，或回复“拒绝”取消。`;
  }

  private async getLatestAssistantText(threadId: string): Promise<string> {
    const snapshot = (await (this.workflow as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<{
        values?: unknown;
      }>;
    }).getState({
      configurable: { thread_id: threadId }
    })) as {
      values?: unknown;
    };

    const messages = this.getStateMessages(snapshot.values);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.getType() !== "ai") {
        continue;
      }

      const text = this.extractMessageText(message.content).trim();
      if (text) {
        return text;
      }
    }

    return "";
  }

  private getStateMessages(values: unknown): BaseMessage[] {
    if (!values || typeof values !== "object") {
      return [];
    }

    const candidate = values as { messages?: unknown };
    if (!Array.isArray(candidate.messages)) {
      return [];
    }

    return candidate.messages.filter((message): message is BaseMessage =>
      BaseMessage.isInstance(message)
    );
  }

  private toToolAgentMessage(message: BaseMessage): ToolAgentMessage | null {
    const role = message.getType();
    if (role !== "human" && role !== "ai") {
      return null;
    }

    return {
      role: role === "human" ? "user" : "assistant",
      content: this.extractMessageText(message.content)
    };
  }

  private createContext(userId: string, threadId: string): AgentContext {
    return AgentContextSchema.parse({
      userId: userId.trim(),
      threadId: threadId.trim()
    });
  }

  private extractFinalText(messages: unknown[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index] as { content?: unknown };
      const text = this.extractMessageText(candidate.content);
      if (text) {
        return text;
      }
    }

    throw new Error("LangChain Tool Agent returned an empty response.");
  }

  private toLangChainMessages(messages: ToolAgentMessage[]) {
    return messages.map((message) =>
      message.role === "user"
        ? new HumanMessage(message.content)
        : new AIMessage(message.content)
    );
  }

  private extractMessageText(content: unknown): string {
    // 学习点：LangChain 消息内容可能是字符串，也可能是 block 数组。
    // 这里统一抽出可展示的 text。
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((block) => {
        if (
          block &&
          typeof block === "object" &&
          "text" in block &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }

        return "";
      })
      .join("");
  }

  private extractStreamTokenText(token: unknown): string {
    if (!token || typeof token !== "object") {
      return "";
    }

    const candidate = token as {
      content?: unknown;
      contentBlocks?: unknown;
      text?: unknown;
    };

    return (
      this.extractMessageText(candidate.content) ||
      this.extractMessageText(candidate.contentBlocks) ||
      (typeof candidate.text === "string" ? candidate.text : "")
    );
  }

  private extractStreamChunkText(streamChunk: unknown, currentText: string): string {
    // 学习点：LangChain 不同版本/不同 streamMode 返回结构可能不同。
    // 为什么这样：统一兼容 [message, metadata]、{ messages }、{ content } 等形态，避免流式输出退化成结束后一次性显示。
    if (Array.isArray(streamChunk)) {
      const [token, metadata] = streamChunk as [unknown, { langgraph_node?: string }?];
      if (metadata?.langgraph_node && metadata.langgraph_node !== "model") {
        return "";
      }

      return this.extractNewTextDelta(this.extractStreamTokenText(token), currentText);
    }

    if (!streamChunk || typeof streamChunk !== "object") {
      return "";
    }

    const candidate = streamChunk as {
      messages?: unknown;
      content?: unknown;
      contentBlocks?: unknown;
      text?: unknown;
    };

    if (Array.isArray(candidate.messages)) {
      const latestMessage = candidate.messages[candidate.messages.length - 1];
      const text = this.extractMessageText((latestMessage as { content?: unknown })?.content);
      return this.extractNewTextDelta(text, currentText);
    }

    return this.extractNewTextDelta(this.extractStreamTokenText(candidate), currentText);
  }

  private extractStreamEventText(event: unknown, currentText: string): string {
    // 学习点：streamEvents 才是 LangChain/LangGraph 的 token 级事件流。
    // 为什么这样：agent.stream 更像“状态更新流”，可能等节点结束才返回；streamEvents 可以拿到 on_chat_model_stream。
    if (!event || typeof event !== "object") {
      return "";
    }

    const candidate = event as {
      event?: string;
      data?: {
        chunk?: unknown;
        output?: unknown;
      };
    };

    if (candidate.event !== "on_chat_model_stream") {
      return "";
    }

    const text =
      this.extractStreamTokenText(candidate.data?.chunk) ||
      this.extractMessageText((candidate.data?.chunk as { content?: unknown } | undefined)?.content) ||
      this.extractMessageText(candidate.data?.output);

    return this.extractNewTextDelta(text, currentText);
  }

  private extractNewTextDelta(text: string, currentText: string): string {
    // 学习点：有些流返回“完整累计文本”，有些返回“本次新增 token”。
    // 为什么这样：如果是累计文本，只追加新增部分，避免前端出现重复回答。
    if (!text) {
      return "";
    }

    if (currentText && text.startsWith(currentText)) {
      return text.slice(currentText.length);
    }

    return text;
  }

  private getBaseUrl(apiUrl: string): string {
    // 用户配置通常是 /chat/completions 或 /responses 端点，LangChain 需要的是 baseURL。
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(
      /\/(?:chat\/completions|responses)\/?$/,
      ""
    );
    return url.toString().replace(/\/$/, "");
  }
}
