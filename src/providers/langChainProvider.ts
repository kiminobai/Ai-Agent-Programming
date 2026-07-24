/**
 * LangChain.js 版 AI Assistant Provider。
 *
 * DeepSeek、OpenAI、SiliconFlow 都通过此适配器进入同一套 LangChain
 * 模型、消息、工具循环与 LangGraph 短期记忆。
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
  // Agent 必须长期复用，其内部 MemorySaver 才不会随请求结束而丢失。
  private readonly agents = new Map<string, LangChainToolAgent>();
  // 记录已开始的线程，防止每一轮都重复写入 Few-shot 示例。
  private readonly initializedThreads = new Set<string>();

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
    threadId = crypto.randomUUID()
  ): Promise<string> {
    // 步骤 1：请求模型前确认当前 Provider 的 API Key 已配置。
    this.requireApiKey();

    // 步骤 2：按本次选择的模型和角色 Prompt 创建 Tool Agent。
    const agent = this.getOrCreateToolAgent(
      modelId,
      systemPrompt,
      reasoningEffort
    );
    const memoryKey = this.createMemoryKey(
      modelId,
      systemPrompt,
      threadId,
      reasoningEffort
    );
    const includeFewShot = !this.initializedThreads.has(memoryKey);

    // 步骤 3：组装 Few-shot + 用户问题，执行非流式 Agent Loop。
    const reply = await agent.invoke(
      this.buildMessages(message, includeFewShot ? fewShotExamples : []),
      threadId
    );
    this.initializedThreads.add(memoryKey);
    return reply;
  }

  async streamChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[] = [],
    reasoningEffort?: ReasoningEffort,
    threadId = crypto.randomUUID()
  ): Promise<string> {
    // 步骤 1：流式请求同样先检查服务端密钥。
    this.requireApiKey();

    // 步骤 2：创建 Agent；onDelta 会由 Agent 逐 Token 回调。
    const agent = this.getOrCreateToolAgent(
      modelId,
      systemPrompt,
      reasoningEffort
    );
    const memoryKey = this.createMemoryKey(
      modelId,
      systemPrompt,
      threadId,
      reasoningEffort
    );
    const includeFewShot = !this.initializedThreads.has(memoryKey);

    // 步骤 3：Provider 不执行工具循环，createAgent 会自动完成。
    const reply = await agent.stream(
      this.buildMessages(message, includeFewShot ? fewShotExamples : []),
      threadId,
      onDelta
    );
    this.initializedThreads.add(memoryKey);
    return reply;
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

    // 首次使用某个“模型 + 角色”组合时创建 Agent，后续请求复用。
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

  private createMemoryKey(
    modelId: string,
    systemPrompt: string,
    threadId: string,
    reasoningEffort?: ReasoningEffort
  ): string {
    // 相同浏览器线程在不同模型或角色之间切换时，记忆保持隔离。
    return [
      this.id,
      modelId,
      systemPrompt,
      reasoningEffort ?? "",
      threadId
    ].join("\u0000");
  }

  private buildMessages(
    message: string,
    fewShotExamples: FewShotExample[]
  ): ToolAgentMessage[] {
    // 步骤 1：Few-shot 示例按 User/Assistant 成对展开。
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
      // 步骤 2：示例在前，当前真实用户问题始终放在最后。
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
}
