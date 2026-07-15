export type ProviderId = "deepseek" | "openai" | "siliconflow";

export interface ModelOption {
  id: string;
  label: string;
  provider: ProviderId;
  description: string;
  enabled: boolean;
  unavailableReason?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FewShotExample {
  user: string;
  assistant: string;
}

export interface PromptRole {
  id: string;
  label: string;
  summary: string;
  systemPrompt: string;
  fewShotExamples?: FewShotExample[];
}

export interface ChatRequestPayload {
  modelId: string;
  message: string;
  roleId: string;
}

export interface ChatResponsePayload {
  reply: string;
  meta: {
    provider: ProviderId;
    modelId: string;
    modelLabel: string;
    roleId: string;
  };
}

export interface ProviderConfig {
  apiKey: string;
  apiUrl: string;
}

export interface ChatProvider {
  id: ProviderId;
  isAvailable(): boolean;
  sendChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples?: FewShotExample[]
  ): Promise<string>;
}
