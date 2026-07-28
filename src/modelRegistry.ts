/**
 * 根据 Provider 可用性生成安全的前端模型列表。
 */
import { modelCatalog } from "./config";
import { ChatProvider, ModelOption } from "./types";

// 学习点：这里控制“用户能在前端下拉框选择的聊天模型”。
// Embedding、Rerank 等 RAG 内部模型只给后端使用，不能放进用户聊天模型列表。
const publicChatModelIds = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "kimi-k2.6"
]);

export function getPublicModels(
  providers: Map<string, ChatProvider>
): ModelOption[] {
  return modelCatalog.filter((model) => publicChatModelIds.has(model.id)).map((model) => {
    // 只有模型已启用且对应 Provider 配置了 Key 时，前端才允许选择。
    const provider = providers.get(model.provider);
    const isAvailable = model.enabled && Boolean(provider?.isAvailable());

    return {
      ...model,
      enabled: isAvailable,
      unavailableReason: isAvailable
        ? undefined
        : `未配置 ${model.provider} 的 API Key`
    };
  });
}

export function getModelById(modelId: string): ModelOption | undefined {
  return modelCatalog.find(
    (model) => publicChatModelIds.has(model.id) && model.id === modelId && model.enabled
  );
}
