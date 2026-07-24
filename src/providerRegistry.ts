import { appConfig, getProviderConfig } from "./config";
import { LangChainProvider } from "./providers/langChainProvider";
import { OpenAICompatibleProvider } from "./providers/openaiCompatibleProvider";
import { ChatProvider, ProviderId } from "./types";

export function createProviderRegistry(): Map<ProviderId, ChatProvider> {
  const deepSeekConfig = getProviderConfig("deepseek");
  const deepSeekProvider =
    appConfig.deepSeekAgentEngine === "langchain"
      ? new LangChainProvider(deepSeekConfig)
      : new OpenAICompatibleProvider("deepseek", deepSeekConfig);

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
