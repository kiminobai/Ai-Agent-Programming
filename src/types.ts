/**
 * 学习点：这里放服务端、Provider 和 React 前端都会用到的共享类型。
 * 这些类型相当于项目内部的“数据契约”。
 */
export type ProviderId = "deepseek" | "openai" | "siliconflow" | "moonshot";

// 学习点：reasoningEffort 主要给支持推理强度的模型使用。
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

// 学习点：usageProfile 是用户可见的资源档位，不把 RPM、TPM 等开发参数暴露到前端。
export type UsageProfile = "economy" | "balanced" | "performance";

// 学习点：前端模型下拉框展示的就是 ModelOption。
export interface ModelOption {
  id: string;
  label: string;
  provider: ProviderId;
  description: string;
  enabled: boolean;
  supportsVision?: boolean;
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

// 学习点：一个 PromptRole 就是一种系统角色。
// 里面包含 systemPrompt 和可选 few-shot 示例。
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
  threadId: string;
  userId: string;
  turnId?: string;
  reasoningEffort?: ReasoningEffort;
  usageProfile?: UsageProfile;
  attachmentName?: string;
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

export type AgentProgress = {
  stage:
    | "thinking"
    | "subagent"
    | "editing_file"
    | "running_command"
    | "generating_file"
    | "finalizing"
    | "task_plan";
  message: string;
  taskPlan?: {
    title: string;
    status: "running" | "completed" | "failed" | "cancelled";
    steps: Array<{
      id: string;
      title: string;
      status:
        | "pending"
        | "in_progress"
        | "completed"
        | "failed"
        | "cancelled";
    }>;
  };
  subAgent?: {
    agentId: string;
    agentLabel: string;
    taskSummary: string;
    status: "running" | "succeeded" | "failed";
  };
};

// 学习点：ChatProvider 是所有模型供应商必须实现的统一接口。
// DeepSeek、OpenAI、SiliconFlow 都被包装成这个形状。
export interface ChatProvider {
  id: ProviderId;
  isAvailable(): boolean;
  sendChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples?: FewShotExample[],
    reasoningEffort?: ReasoningEffort,
    threadId?: string,
    userId?: string,
    turnId?: string,
    usageProfile?: UsageProfile
  ): Promise<string>;
  streamChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples?: FewShotExample[],
    reasoningEffort?: ReasoningEffort,
    threadId?: string,
    userId?: string,
    signal?: AbortSignal,
    turnId?: string,
    onProgress?: (progress: AgentProgress) => void,
    usageProfile?: UsageProfile
  ): Promise<string>;
}
