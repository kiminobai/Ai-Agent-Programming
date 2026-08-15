import { getModelById } from "../modelRegistry";
import { getPromptRoleById } from "../prompts";
import { createProviderRegistry } from "../providerRegistry";
import { updateThreadAfterMessage } from "../threads/threadRepository";
import type { ReasoningEffort, UsageProfile } from "../types";
import type { BackgroundTask } from "./backgroundTaskRepository";
import type { BackgroundTaskHandler } from "./backgroundTaskWorker";

export type AgentChatTaskPayload = {
  modelId: string;
  roleId: string;
  userMessage: string;
  messageForModel: string;
  reasoningEffort?: ReasoningEffort;
  usageProfile: UsageProfile;
  isApprovalControlMessage: boolean;
};

const providers = createProviderRegistry();

// API 只负责入队；真正的模型和 Agent 调用由独立 Worker 进程执行。
export const executeAgentChatTask: BackgroundTaskHandler = async (
  task: BackgroundTask,
  helpers
): Promise<{ reply: string }> => {
  const payload = task.payload as AgentChatTaskPayload;
  const model = getModelById(payload.modelId);
  const role = getPromptRoleById(payload.roleId);
  if (!model || !role) throw new Error("任务使用的模型或角色已经不可用。");
  const provider = providers.get(model.provider);
  if (!provider || !provider.isAvailable()) {
    throw new Error(`${model.label} 当前不可用，请检查 API Key。`);
  }
  const meta = {
    provider: model.provider,
    modelId: model.id,
    modelLabel: model.label,
    roleId: role.id,
    userId: task.userId,
    threadId: task.threadId,
    taskId: task.taskId
  };
  helpers.emit({ type: "meta", meta });
  helpers.progress(15, "thinking", "正在思考");
  const reply = await provider.streamChat(
    model.id,
    payload.messageForModel,
    role.systemPrompt,
    (chunk) => helpers.emit({ type: "delta", chunk }),
    role.fewShotExamples,
    payload.reasoningEffort,
    task.threadId,
    task.userId,
    helpers.signal,
    task.turnId,
    (progress) => {
      helpers.progress(progress.stage === "finalizing" ? 90 : 45, progress.stage, progress.message);
      helpers.emit({ type: "status", ...progress });
    },
    payload.usageProfile
  );
  if (!payload.isApprovalControlMessage) {
    updateThreadAfterMessage({
      threadId: task.threadId,
      userId: task.userId,
      providerId: model.provider,
      modelId: model.id,
      roleId: role.id,
      reasoningEffort: payload.reasoningEffort,
      userMessage: payload.userMessage
    });
  }
  helpers.progress(95, "finalizing", "正在整理结果");
  helpers.emit({ type: "done", reply, meta });
  return { reply };
};
