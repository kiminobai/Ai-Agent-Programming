import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import {
  ChatProvider,
  FewShotExample,
  ProviderConfig,
  ReasoningEffort
} from "../types";
import { langChainTools } from "../tools/langChainTools";

type AgentMessage = {
  role: "user" | "assistant";
  content: string;
};

export class LangChainProvider implements ChatProvider {
  readonly id = "deepseek" as const;

  constructor(private readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return Boolean(this.config.apiKey);
  }

  async sendChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[] = [],
    _reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    this.requireApiKey();
    const agent = this.createDeepSeekAgent(modelId, systemPrompt);
    const result = await agent.invoke({
      messages: this.buildMessages(message, fewShotExamples)
    });

    return this.extractFinalText(result.messages);
  }

  async streamChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[] = [],
    _reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    this.requireApiKey();
    const agent = this.createDeepSeekAgent(modelId, systemPrompt);
    const stream = await agent.stream(
      {
        messages: this.buildMessages(message, fewShotExamples)
      },
      {
        streamMode: "messages"
      }
    );
    let fullText = "";

    for await (const [token, metadata] of stream) {
      if (metadata.langgraph_node === "tools") {
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
      throw new Error("LangChain agent returned an empty response.");
    }

    return fullText;
  }

  private createDeepSeekAgent(modelId: string, systemPrompt: string) {
    const model = new ChatOpenAI({
      apiKey: this.config.apiKey,
      model: modelId,
      temperature: 0,
      streamUsage: false,
      configuration: {
        baseURL: this.getBaseUrl(this.config.apiUrl)
      }
    });

    return createAgent({
      model,
      tools: langChainTools,
      systemPrompt
    });
  }

  private buildMessages(
    message: string,
    fewShotExamples: FewShotExample[]
  ): AgentMessage[] {
    const exampleMessages = fewShotExamples.flatMap<AgentMessage>((example) => [
      {
        role: "user",
        content: example.user
      },
      {
        role: "assistant",
        content: example.assistant
      }
    ]);

    return [
      ...exampleMessages,
      {
        role: "user",
        content: message
      }
    ];
  }

  private extractFinalText(messages: unknown[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index] as { content?: unknown };
      const text = this.extractMessageText(candidate.content);
      if (text) {
        return text;
      }
    }

    throw new Error("LangChain agent returned an empty response.");
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
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(
      /\/(?:v1\/)?chat\/completions\/?$/,
      ""
    );
    return url.toString().replace(/\/$/, "");
  }

  private requireApiKey(): void {
    if (!this.config.apiKey) {
      throw new Error("deepseek has no API key configured.");
    }
  }
}
