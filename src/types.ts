/**
 * 项目跨层共享的领域类型。
 * Provider、服务端接口和 React 前端应以这里的契约为准。
 */
export type ProviderId = "deepseek" | "openai" | "siliconflow";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

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
  // 同一对话复用 threadId，LangGraph 才能恢复消息和工具调用历史。
  threadId: string;
  reasoningEffort?: ReasoningEffort;
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
  reasoningEffort?: ReasoningEffort;
}

export interface ChatProvider {
  // 所有 Provider 都提供相同调用方式，Registry 才能按模型动态选择实现。
  id: ProviderId;
  isAvailable(): boolean;
  sendChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples?: FewShotExample[],
    reasoningEffort?: ReasoningEffort,
    threadId?: string
  ): Promise<string>;
  streamChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples?: FewShotExample[],
    reasoningEffort?: ReasoningEffort,
    threadId?: string
  ): Promise<string>;
}
