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

export interface ChatRequestPayload {
  modelId: string;
  message: string;
}

export interface ChatResponsePayload {
  reply: string;
  meta: {
    provider: ProviderId;
    modelId: string;
    modelLabel: string;
  };
}

export interface ProviderConfig {
  apiKey: string;
  apiUrl: string;
}

export interface ChatProvider {
  id: ProviderId;
  isAvailable(): boolean;
  sendChat(modelId: string, message: string): Promise<string>;
}
