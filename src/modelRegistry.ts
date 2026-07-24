/**
 * 根据 Provider 可用性生成安全的前端模型列表。
 */
import { modelCatalog } from "./config";
import { ChatProvider, ModelOption } from "./types";

export function getPublicModels(
  providers: Map<string, ChatProvider>
): ModelOption[] {
  return modelCatalog.map((model) => {
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
  return modelCatalog.find((model) => model.id === modelId && model.enabled);
}
