/**
 * 学习点：这是 LangChain 版 Tool Agent。
 *
 * 它把模型、System Prompt、Tools、短期记忆和 SQLite checkpointer
 * 组装到 createAgent 里，形成标准 Agent Loop。
 */
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, summarizationMiddleware } from "langchain";
import { sqliteCheckpointer } from "../db/sqlite";
import { langChainTools } from "../tools/langchain";
import { ProviderId, ReasoningEffort } from "../types";
import { AgentContext, AgentContextSchema } from "./agentContext";
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
  reasoningEffort?: ReasoningEffort;
}

export class LangChainToolAgent {
  private static readonly SUMMARY_TRIGGER_TOKENS = 8_000;
  private static readonly SUMMARY_KEEP_MESSAGES = 12;

  private readonly agent;

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

    this.agent = createAgent({
      model,
      tools: langChainTools,
      systemPrompt: options.systemPrompt,
      stateSchema: ToolMemoryState,
      contextSchema: AgentContextSchema,
      // 学习点：每次模型调用前，动态拼接长期记忆、短期工具上下文和上传文档状态。
      middleware: [memorySummarizer, dynamicMemoryPromptMiddleware],
      // 学习点：LangGraph thread state 写入 SQLite，项目重启后仍可恢复该 thread。
      checkpointer: sqliteCheckpointer
    });
  }

  async invoke(
    messages: ToolAgentMessage[],
    threadId: string,
    userId: string
  ): Promise<string> {
    // 学习点：thread_id 是 LangGraph 短期记忆的分区键。
    // 同一个 thread 会继续使用同一份状态。
    const result = await this.agent.invoke(
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
    onDelta: (chunk: string) => void
  ): Promise<string> {
    // 学习点：streamMode=messages 会持续返回模型 token。
    // 工具节点输出会被过滤，避免把内部过程展示给用户。
    const run = await this.agent.streamEvents(
      { messages: this.toLangChainMessages(messages) },
      {
        version: "v3",
        configurable: { thread_id: threadId },
        context: this.createContext(userId, threadId)
      }
    );

    let fullText = "";

    for await (const messageStream of run.messages) {
      for await (const token of messageStream.text) {
        const delta = this.extractNewTextDelta(String(token || ""), fullText);
        if (!delta) {
          continue;
        }

        fullText += delta;
        onDelta(delta);
      }
    }

    if (!fullText) {
      // 学习点：如果流里没有 token，就从 LangGraph state 里兜底找最后一条 AI 消息。
      fullText = await this.getLatestAssistantText(threadId);
      if (fullText) {
        onDelta(fullText);
      }
    }

    if (!fullText) {
      return "文件已经读取并切分完成，但模型没有生成最终文本回复。请继续输入你希望我基于文件完成的具体任务，例如总结、提取重点、按章节分析或对比内容。";
    }

    return fullText;
  }

  async hasThreadState(threadId: string): Promise<boolean> {
    const snapshot = (await (this.agent as {
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
    const snapshot = (await (this.agent as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<{
        values?: unknown;
      }>;
    }).getState({
      configurable: { thread_id: threadId }
    })) as {
      values?: unknown;
    };

    return this.getStateMessages(snapshot.values)
      .map((message) => this.toToolAgentMessage(message))
      .filter((message): message is ToolAgentMessage => Boolean(message));
  }

  private async getLatestAssistantText(threadId: string): Promise<string> {
    const snapshot = (await (this.agent as {
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
