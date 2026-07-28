/**
 * Provider 依赖注册中心：根据环境配置组装各模型供应商实现。
 */
import { getProviderConfig } from "./config";
import { LangChainProvider } from "./providers/langChainProvider";
import { ChatProvider, ProviderId } from "./types";

export function createProviderRegistry(): Map<ProviderId, ChatProvider> {
  // 所有模型统一进入 LangChain AI Assistant；原生 Provider 仅保留为学习资料。
  return new Map<ProviderId, ChatProvider>([
    [
      "deepseek",
      new LangChainProvider("deepseek", getProviderConfig("deepseek"))
    ],
    [
      "openai",
      new LangChainProvider("openai", getProviderConfig("openai"))
    ],
    [
      "siliconflow",
      new LangChainProvider("siliconflow", getProviderConfig("siliconflow"))
    ],
    [
      "moonshot",
      new LangChainProvider("moonshot", getProviderConfig("moonshot"))
    ]
  ]);
}
