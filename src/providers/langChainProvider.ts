/**
 * 将 LangChainToolAgent 适配为项目统一的 ChatProvider 接口。
 * HTTP 层只依赖 ChatProvider，因此可以在 LangChain 与原生 SDK 间切换。
 */
import {
  LangChainToolAgent,
  ToolAgentMessage
} from "../agents/langChainToolAgent";
import {
  ChatProvider,
  FewShotExample,
  ProviderConfig,
  ReasoningEffort
} from "../types";

export class LangChainProvider implements ChatProvider {
  readonly id = "deepseek" as const;
  // Agent 必须长期复用，其内部 MemorySaver 才不会随请求结束而丢失。
  private readonly agents = new Map<string, LangChainToolAgent>();
  // 记录已开始的线程，防止每一轮都重复写入 Few-shot 示例。
  private readonly initializedThreads = new Set<string>();

  constructor(private readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return Boolean(this.config.apiKey);
  }

  async sendChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[] = [],
    _reasoningEffort?: ReasoningEffort,
    threadId = crypto.randomUUID()
  ): Promise<string> {
    // 步骤 1：请求模型前确认 DeepSeek Key 已配置。
    this.requireApiKey();

    // 步骤 2：按本次选择的模型和角色 Prompt 创建 Tool Agent。
    const agent = this.getOrCreateToolAgent(modelId, systemPrompt);
    const memoryKey = this.createMemoryKey(modelId, systemPrompt, threadId);
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
    _reasoningEffort?: ReasoningEffort,
    threadId = crypto.randomUUID()
  ): Promise<string> {
    // 步骤 1：流式请求同样先检查服务端密钥。
    this.requireApiKey();

    // 步骤 2：创建 Agent；onDelta 会由 Agent 逐 Token 回调。
    const agent = this.getOrCreateToolAgent(modelId, systemPrompt);
    const memoryKey = this.createMemoryKey(modelId, systemPrompt, threadId);
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

  private getOrCreateToolAgent(modelId: string, systemPrompt: string) {
    const agentKey = `${modelId}\u0000${systemPrompt}`;
    const existingAgent = this.agents.get(agentKey);
    if (existingAgent) {
      return existingAgent;
    }

    // 首次使用某个“模型 + 角色”组合时创建 Agent，后续请求复用。
    const agent = new LangChainToolAgent({
      apiKey: this.config.apiKey,
      apiUrl: this.config.apiUrl,
      modelId,
      systemPrompt
    });
    this.agents.set(agentKey, agent);
    return agent;
  }

  private createMemoryKey(
    modelId: string,
    systemPrompt: string,
    threadId: string
  ): string {
    // 相同浏览器线程在不同模型或角色之间切换时，记忆保持隔离。
    return `${modelId}\u0000${systemPrompt}\u0000${threadId}`;
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
      throw new Error("deepseek has no API key configured.");
    }
  }
}
