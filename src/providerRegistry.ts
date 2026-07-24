/**
 * Provider 依赖注册中心：根据环境配置组装各模型供应商实现。
 */
import { appConfig, getProviderConfig } from "./config";
import { LangChainProvider } from "./providers/langChainProvider";
import { OpenAICompatibleProvider } from "./providers/openaiCompatibleProvider";
import { ChatProvider, ProviderId } from "./types";

export function createProviderRegistry(): Map<ProviderId, ChatProvider> {
  // 步骤 1：读取 DeepSeek 服务端配置。
  const deepSeekConfig = getProviderConfig("deepseek");

  // 步骤 2：根据开关选择 LangChain Agent 或原生 SDK 实现。
  const deepSeekProvider =
    // 默认使用 LangChain；native 用于学习原生 Tool Calling 或紧急回退。
    appConfig.deepSeekAgentEngine === "langchain"
      ? new LangChainProvider(deepSeekConfig)
      : new OpenAICompatibleProvider("deepseek", deepSeekConfig);

  // 步骤 3：注册表把 ProviderId 映射到统一 ChatProvider。
  return new Map<ProviderId, ChatProvider>([
    ["deepseek", deepSeekProvider],
    [
      "openai",
      new OpenAICompatibleProvider("openai", getProviderConfig("openai"))
    ],
    [
      "siliconflow",
      new OpenAICompatibleProvider(
        "siliconflow",
        getProviderConfig("siliconflow")
      )
    ]
  ]);
}
