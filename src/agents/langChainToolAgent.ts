/**
 * LangChain 版 Tool Agent。
 *
 * 负责把 OpenAI 兼容模型、System Prompt 和三个 LangChain Tool 交给
 * createAgent 组装成完整的“模型判断 -> 工具执行 -> 再次判断”循环。
 */
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import {
  createAgent,
  summarizationMiddleware
} from "langchain";
import { langChainTools } from "../tools/langchain";
import { ProviderId, ReasoningEffort } from "../types";
import { dynamicMemoryPromptMiddleware } from "./dynamicMemoryPromptMiddleware";
import { ToolMemoryState } from "./toolMemoryState";

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
  // 接近该 Token 数时触发摘要，避免完整历史无限进入模型上下文。
  private static readonly SUMMARY_TRIGGER_TOKENS = 8_000;
  // 摘要旧历史后仍保留最近消息，维持当前任务和 Tool Call 连贯性。
  private static readonly SUMMARY_KEEP_MESSAGES = 12;

  // MemorySaver 按 thread_id 保存 State，其中包含 User、AI、Tool Call 和 Tool Result。
  private readonly checkpointer = new MemorySaver();

  // createAgent 返回的是一个已编译的 LangGraph Agent，可 invoke 或 stream。
  private readonly agent;

  constructor(options: LangChainToolAgentOptions) {
    // 步骤 1：把项目模型配置转换为 LangChain ChatOpenAI 实例。
    // 三个平台都提供 OpenAI 兼容接口，由 LangChain 统一管理模型调用。
    const model = new ChatOpenAI({
      apiKey: options.apiKey,
      model: options.modelId,
      temperature: 0,
      streamUsage: false,
      reasoning:
        options.providerId === "openai"
          ? { effort: options.reasoningEffort }
          : undefined,
      configuration: {
        baseURL: this.getBaseUrl(options.apiUrl)
      }
    });

    // 步骤 2：配置官方摘要 Middleware。
    // Middleware 会在调用模型前检查历史长度，超限时把旧消息压缩为摘要。
    const memorySummarizer = summarizationMiddleware({
      model,
      trigger: {
        tokens: LangChainToolAgent.SUMMARY_TRIGGER_TOKENS
      },
      keep: {
        messages: LangChainToolAgent.SUMMARY_KEEP_MESSAGES
      }
    });

    // 步骤 3：createAgent 注册模型、System Prompt、工具与摘要 Middleware。
    // createAgent 内部会创建基于 LangGraph 的 Model Node 与 Tools Node 循环。
    this.agent = createAgent({
      model,
      tools: langChainTools,
      systemPrompt: options.systemPrompt,
      stateSchema: ToolMemoryState,
      middleware: [memorySummarizer, dynamicMemoryPromptMiddleware],
      checkpointer: this.checkpointer
    });
  }

  async invoke(
    messages: ToolAgentMessage[],
    threadId: string
  ): Promise<string> {
    // 步骤 4A：非流式调用等待整个 Agent Loop 完成。
    // 模型若产生 Tool Call，createAgent 会自动执行工具并再次调用模型。
    const result = await this.agent.invoke(
      {
        messages: this.toLangChainMessages(messages)
      },
      {
        // 步骤 4A.1：LangGraph 用 thread_id 找到并合并上一轮 State。
        configurable: { thread_id: threadId }
      }
    );

    // 步骤 5A：从最终 State 的消息列表中提取最后一条有效文本。
    return this.extractFinalText(result.messages);
  }

  async stream(
    messages: ToolAgentMessage[],
    threadId: string,
    onDelta: (chunk: string) => void
  ): Promise<string> {
    // 步骤 4B：messages 模式逐个返回模型 Token 与 ToolMessage。
    const stream = await this.agent.stream(
      { messages: this.toLangChainMessages(messages) },
      {
        streamMode: "messages",
        // 步骤 4B.1：相同 thread_id 会恢复刚才的 Tool Call 与 Tool Result。
        configurable: { thread_id: threadId }
      }
    );
    let fullText = "";

    for await (const [token, metadata] of stream) {
      // 步骤 5B：工具 JSON 只用于模型观察，不能直接显示在聊天 UI。
      if (metadata.langgraph_node === "tools") {
        continue;
      }

      // 步骤 6B：兼容 content、contentBlocks 和 text 三种 Token 结构。
      const delta = this.extractStreamTokenText(token);
      if (!delta) {
        continue;
      }

      // 步骤 7B：一份用于最终返回，一份即时推送给上层 SSE。
      fullText += delta;
      onDelta(delta);
    }

    if (!fullText) {
      throw new Error("LangChain Tool Agent returned an empty response.");
    }

    return fullText;
  }

  private extractFinalText(messages: unknown[]): string {
    // 从后向前找，跳过没有文本的 ToolMessage 或空 AIMessage。
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
    // 步骤 0：在 Agent 边界把项目 DTO 转成 LangChain 消息对象。
    // 业务层因此不需要直接依赖 HumanMessage / AIMessage。
    return messages.map((message) =>
      message.role === "user"
        ? new HumanMessage(message.content)
        : new AIMessage(message.content)
    );
  }

  private extractMessageText(content: unknown): string {
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
          typeof block.text === "string"
        ) {
          return block.text;
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

  private getBaseUrl(apiUrl: string): string {
    // ChatOpenAI 会自行追加 /chat/completions，因此只移除配置中的接口尾路径。
    // 保留 /v1：OpenAI 和 SiliconFlow 的兼容 Base URL 都需要这一层路径。
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(
      /\/(?:chat\/completions|responses)\/?$/,
      ""
    );
    return url.toString().replace(/\/$/, "");
  }
}
