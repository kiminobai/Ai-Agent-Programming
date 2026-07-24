/**
 * LangChain 版 Tool Agent。
 *
 * 负责把 DeepSeek 模型、System Prompt 和三个 LangChain Tool 交给
 * createAgent 组装成完整的“模型判断 -> 工具执行 -> 再次判断”循环。
 */
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { langChainTools } from "../tools/langchain";

export interface ToolAgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LangChainToolAgentOptions {
  apiKey: string;
  apiUrl: string;
  modelId: string;
  systemPrompt: string;
}

export class LangChainToolAgent {
  // createAgent 返回的是一个已编译的 LangGraph Agent，可 invoke 或 stream。
  private readonly agent;

  constructor(options: LangChainToolAgentOptions) {
    // 步骤 1：把项目模型配置转换为 LangChain ChatOpenAI 实例。
    // DeepSeek 提供 OpenAI 兼容接口，所以只需替换 baseURL 和 API Key。
    const model = new ChatOpenAI({
      apiKey: options.apiKey,
      model: options.modelId,
      temperature: 0,
      streamUsage: false,
      configuration: {
        baseURL: this.getBaseUrl(options.apiUrl)
      }
    });

    // 步骤 2：createAgent 注册模型、System Prompt 和全部工具。
    // createAgent 内部会创建基于 LangGraph 的 Model Node 与 Tools Node 循环。
    this.agent = createAgent({
      model,
      tools: langChainTools,
      systemPrompt: options.systemPrompt
    });
  }

  async invoke(messages: ToolAgentMessage[]): Promise<string> {
    // 步骤 3A：非流式调用等待整个 Agent Loop 完成。
    // 模型若产生 Tool Call，createAgent 会自动执行工具并再次调用模型。
    const result = await this.agent.invoke({
      messages: this.toLangChainMessages(messages)
    });

    // 步骤 4A：从最终 State 的消息列表中提取最后一条有效文本。
    return this.extractFinalText(result.messages);
  }

  async stream(
    messages: ToolAgentMessage[],
    onDelta: (chunk: string) => void
  ): Promise<string> {
    // 步骤 3B：messages 模式逐个返回模型 Token 与 ToolMessage。
    const stream = await this.agent.stream(
      { messages: this.toLangChainMessages(messages) },
      { streamMode: "messages" }
    );
    let fullText = "";

    for await (const [token, metadata] of stream) {
      // 步骤 4B：工具 JSON 只用于模型观察，不能直接显示在聊天 UI。
      if (metadata.langgraph_node === "tools") {
        continue;
      }

      // 步骤 5B：兼容 content、contentBlocks 和 text 三种 Token 结构。
      const delta = this.extractStreamTokenText(token);
      if (!delta) {
        continue;
      }

      // 步骤 6B：一份用于最终返回，一份即时推送给上层 SSE。
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
    // ChatOpenAI 需要 API 根地址，而配置允许填写完整的 chat/completions 地址。
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(
      /\/(?:v1\/)?chat\/completions\/?$/,
      ""
    );
    return url.toString().replace(/\/$/, "");
  }
}
