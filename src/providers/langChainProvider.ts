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
    threadId = crypto.randomUUID(),
    userId = "default-user"
  ): Promise<string> {
    this.requireApiKey();

    const agent = this.getOrCreateToolAgent(
      modelId,
      systemPrompt,
      reasoningEffort
    );
    const includeFewShot = !(await agent.hasThreadState(threadId));

    return agent.invoke(
      this.buildMessages(message, includeFewShot ? fewShotExamples : []),
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
    threadId = crypto.randomUUID(),
    userId = "default-user"
  ): Promise<string> {
    this.requireApiKey();

    const agent = this.getOrCreateToolAgent(
      modelId,
      systemPrompt,
      reasoningEffort
    );
    const includeFewShot = !(await agent.hasThreadState(threadId));

    return agent.stream(
      this.buildMessages(message, includeFewShot ? fewShotExamples : []),
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
      reasoningEffort
    );
    const messages = await agent.getThreadMessages(threadId);
    return this.stripFewShotMessages(messages, fewShotExamples);
  }

  private getOrCreateToolAgent(
    modelId: string,
    systemPrompt: string,
    reasoningEffort?: ReasoningEffort
  ) {
    const effectiveReasoningEffort =
      this.id === "openai"
        ? reasoningEffort ?? this.config.reasoningEffort
        : undefined;
    const agentKey = [
      this.id,
      modelId,
      systemPrompt,
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
      systemPrompt,
      reasoningEffort: effectiveReasoningEffort
    });
    this.agents.set(agentKey, agent);
    return agent;
  }

  private buildMessages(
    message: string,
    fewShotExamples: FewShotExample[]
  ): ToolAgentMessage[] {
    const exampleMessages = fewShotExamples.flatMap<ToolAgentMessage>(
      (example) => [
        {
          role: "user",
          content: example.user
        },
        {
          role: "assistant",
          content: example.assistant
        }
      ]
    );

    return [
      ...exampleMessages,
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

  private stripFewShotMessages(
    messages: ToolAgentMessage[],
    fewShotExamples: FewShotExample[]
  ): ToolAgentMessage[] {
    if (!fewShotExamples.length) {
      return messages;
    }

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

    const hasPrefix = expectedPrefix.every((message, index) => {
      const candidate = messages[index];
      return (
        candidate?.role === message.role &&
        candidate?.content === message.content
      );
    });

    return hasPrefix ? messages.slice(expectedPrefix.length) : messages;
  }
}
