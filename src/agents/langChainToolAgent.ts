/**
 * LangChain 版 Tool Agent。
 *
 * 负责把模型、Prompt、工具和 SQLite 持久化记忆统一交给 createAgent，
 * 形成“模型判断 -> 工具执行 -> 再次判断”的标准 Agent Loop。
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
      middleware: [memorySummarizer, dynamicMemoryPromptMiddleware],
      checkpointer: sqliteCheckpointer
    });
  }

  async invoke(
    messages: ToolAgentMessage[],
    threadId: string,
    userId: string
  ): Promise<string> {
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
    const stream = await this.agent.stream(
      { messages: this.toLangChainMessages(messages) },
      {
        streamMode: "messages",
        configurable: { thread_id: threadId },
        context: this.createContext(userId, threadId)
      }
    );

    let fullText = "";

    for await (const [token, metadata] of stream) {
      if (
        metadata.langgraph_node &&
        metadata.langgraph_node !== "model"
      ) {
        continue;
      }

      const delta = this.extractStreamTokenText(token);
      if (!delta) {
        continue;
      }

      fullText += delta;
      onDelta(delta);
    }

    if (!fullText) {
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

  private getBaseUrl(apiUrl: string): string {
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(
      /\/(?:chat\/completions|responses)\/?$/,
      ""
    );
    return url.toString().replace(/\/$/, "");
  }
}
