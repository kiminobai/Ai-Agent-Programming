import {
  ChatProvider,
  FewShotExample,
  ProviderConfig,
  ProviderId
} from "../types";

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAICompatibleProvider implements ChatProvider {
  constructor(
    public readonly id: ProviderId,
    private readonly config: ProviderConfig
  ) {}

  isAvailable(): boolean {
    return Boolean(this.config.apiKey);
  }

  async sendChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[] = []
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error(`${this.id} 尚未配置 API Key。`);
    }

    const exampleMessages = fewShotExamples.flatMap((example) => [
      {
        role: "user" as const,
        content: example.user
      },
      {
        role: "assistant" as const,
        content: example.assistant
      }
    ]);

    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          ...exampleMessages,
          {
            role: "user",
            content: message
          }
        ],
        temperature: 0.7,
        stream: false
      })
    });

    const data = (await response.json()) as OpenAICompatibleResponse;

    if (!response.ok) {
      throw new Error(data.error?.message || `${this.id} 接口请求失败。`);
    }

    return data.choices?.[0]?.message?.content?.trim() || "模型没有返回内容。";
  }
}
