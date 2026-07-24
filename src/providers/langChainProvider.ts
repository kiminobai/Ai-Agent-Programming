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
    // 步骤 1：请求模型前确认 DeepSeek Key 已配置。
    this.requireApiKey();

    // 步骤 2：按本次选择的模型和角色 Prompt 创建 Tool Agent。
    const agent = this.createToolAgent(modelId, systemPrompt);

    // 步骤 3：组装 Few-shot + 用户问题，执行非流式 Agent Loop。
    return agent.invoke(this.buildMessages(message, fewShotExamples));
  }

  async streamChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[] = [],
    _reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    // 步骤 1：流式请求同样先检查服务端密钥。
    this.requireApiKey();

    // 步骤 2：创建 Agent；onDelta 会由 Agent 逐 Token 回调。
    const agent = this.createToolAgent(modelId, systemPrompt);

    // 步骤 3：Provider 不执行工具循环，createAgent 会自动完成。
    return agent.stream(this.buildMessages(message, fewShotExamples), onDelta);
  }

  private createToolAgent(modelId: string, systemPrompt: string) {
    // 把 ProviderConfig 映射为可复用 Agent 的构造参数。
    return new LangChainToolAgent({
      apiKey: this.config.apiKey,
      apiUrl: this.config.apiUrl,
      modelId,
      systemPrompt
    });
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
