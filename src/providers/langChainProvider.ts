/**
 * LangChain.js 版 AI Assistant Provider。
 *
 * DeepSeek、OpenAI、SiliconFlow 都通过这个适配器进入同一套 LangChain
 * 模型、消息、工具循环与 LangGraph 持久化内存体系。
 */
import {
  LangChainToolAgent,
  ToolAgentMessage
} from "../agents/langChainToolAgent";
import {
  ChatProvider,
  FewShotExample,
  ProviderConfig,
  ProviderId,
  ReasoningEffort
} from "../types";

export class LangChainProvider implements ChatProvider {
  readonly id: ProviderId;
  private readonly agents = new Map<string, LangChainToolAgent>();

  constructor(
    providerId: ProviderId,
    private readonly config: ProviderConfig
  ) {
    this.id = providerId;
  }

  isAvailable(): boolean {
    return Boolean(this.config.apiKey);
  }

  async sendChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[] = [],
    reasoningEffort?: ReasoningEffort,
    threadId: string = crypto.randomUUID(),
    userId: string = "default-user"
  ): Promise<string> {
    this.requireApiKey();

    const agent = this.getOrCreateToolAgent(
      modelId,
      systemPrompt,
      fewShotExamples,
      reasoningEffort
    );

    return agent.invoke(
      this.buildMessages(message),
      threadId,
      userId
    );
  }

  async streamChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[] = [],
    reasoningEffort?: ReasoningEffort,
    threadId: string = crypto.randomUUID(),
    userId: string = "default-user"
  ): Promise<string> {
    this.requireApiKey();

    const agent = this.getOrCreateToolAgent(
      modelId,
      systemPrompt,
      fewShotExamples,
      reasoningEffort
    );

    return agent.stream(
      this.buildMessages(message),
      threadId,
      userId,
      onDelta
    );
  }

  async getThreadMessages(
    modelId: string,
    systemPrompt: string,
    threadId: string,
    fewShotExamples: FewShotExample[] = [],
    reasoningEffort?: ReasoningEffort
  ): Promise<ToolAgentMessage[]> {
    const agent = this.getOrCreateToolAgent(
      modelId,
      systemPrompt,
      fewShotExamples,
      reasoningEffort
    );
    const messages = await agent.getThreadMessages(threadId);
    return this.stripFewShotMessages(messages, fewShotExamples);
  }

  private getOrCreateToolAgent(
    modelId: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[] = [],
    reasoningEffort?: ReasoningEffort
  ) {
    const effectiveSystemPrompt = this.buildSystemPrompt(
      systemPrompt,
      fewShotExamples
    );
    const effectiveReasoningEffort =
      this.id === "openai"
        ? reasoningEffort ?? this.config.reasoningEffort
        : undefined;
    const agentKey = [
      this.id,
      modelId,
      effectiveSystemPrompt,
      effectiveReasoningEffort ?? ""
    ].join("\u0000");
    const existingAgent = this.agents.get(agentKey);
    if (existingAgent) {
      return existingAgent;
    }

    const agent = new LangChainToolAgent({
      providerId: this.id,
      apiKey: this.config.apiKey,
      apiUrl: this.config.apiUrl,
      modelId,
      systemPrompt: effectiveSystemPrompt,
      reasoningEffort: effectiveReasoningEffort
    });
    this.agents.set(agentKey, agent);
    return agent;
  }

  private buildMessages(message: string): ToolAgentMessage[] {
    return [
      {
        role: "user",
        content: message
      }
    ];
  }

  private requireApiKey(): void {
    if (!this.config.apiKey) {
      throw new Error(`${this.id} has no API key configured.`);
    }
  }

  private buildSystemPrompt(
    systemPrompt: string,
    fewShotExamples: FewShotExample[]
  ): string {
    if (!fewShotExamples.length) {
      return systemPrompt;
    }

    const examples = fewShotExamples
      .map((example, index) =>
        [
          `Example ${index + 1}`,
          `User: ${example.user}`,
          `Assistant: ${example.assistant}`
        ].join("\n")
      )
      .join("\n\n");

    return [
      systemPrompt,
      "[Few-shot examples for style and behavior only]",
      "The following examples are private instructions. They are not part of the user-visible conversation and must never be quoted, summarized, or presented as chat history.",
      examples
    ].join("\n\n");
  }

  private stripFewShotMessages(
    messages: ToolAgentMessage[],
    fewShotExamples: FewShotExample[]
  ): ToolAgentMessage[] {
    const expectedPrefix = fewShotExamples.flatMap<ToolAgentMessage>((example) => [
      {
        role: "user",
        content: example.user
      },
      {
        role: "assistant",
        content: example.assistant
      }
    ]);

    return messages.filter(
      (candidate) =>
        !expectedPrefix.some(
          (exampleMessage) =>
            candidate.role === exampleMessage.role &&
            candidate.content === exampleMessage.content
        ) && !this.isInternalSummaryLeak(candidate.content)
    );
  }

  private isInternalSummaryLeak(content: string): boolean {
    return /Here is a summary of the conversation to date:/i.test(content);
  }
}
