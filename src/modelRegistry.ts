import { modelCatalog } from "./config";
import { ChatProvider, ModelOption } from "./types";

export function getPublicModels(providers: Map<string, ChatProvider>): ModelOption[] {
  return modelCatalog.map((model) => {
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
