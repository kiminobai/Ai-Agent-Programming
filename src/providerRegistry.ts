import { getProviderConfig } from "./config";
import { OpenAICompatibleProvider } from "./providers/openaiCompatibleProvider";
import { ChatProvider, ProviderId } from "./types";

export function createProviderRegistry(): Map<ProviderId, ChatProvider> {
  return new Map<ProviderId, ChatProvider>([
    [
      "deepseek",
      new OpenAICompatibleProvider("deepseek", getProviderConfig("deepseek"))
    ],
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
