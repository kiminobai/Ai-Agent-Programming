import dotenv from "dotenv";
import { ModelOption, ProviderConfig, ProviderId } from "./types";

dotenv.config();

export const appConfig = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  defaultRoleId: process.env.DEFAULT_ROLE_ID || "python-engineer"
};

const providerConfigs: Record<ProviderId, ProviderConfig> = {
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    apiUrl:
      process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions"
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    apiUrl:
      process.env.OPENAI_API_URL ||
      "https://api.openai.com/v1/chat/completions"
  },
  siliconflow: {
    apiKey: process.env.SILICONFLOW_API_KEY || "",
    apiUrl:
      process.env.SILICONFLOW_API_URL ||
      "https://api.siliconflow.cn/v1/chat/completions"
  }
};

export function getProviderConfig(providerId: ProviderId): ProviderConfig {
  return providerConfigs[providerId];
}

export const modelCatalog: ModelOption[] = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "deepseek",
    description: "DeepSeek 轻量通用模型，适合日常问答与快速生成",
    enabled: true
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    description: "DeepSeek 高能力模型，适合复杂分析与深入任务",
    enabled: true
  },
  {
    id: "gpt-4o-mini",
    label: "OpenAI GPT-4o Mini",
    provider: "openai",
    description: "OpenAI 轻量通用模型",
    enabled: true
  },
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    label: "Qwen 2.5 7B Instruct",
    provider: "siliconflow",
    description: "通过 SiliconFlow 接入的 Qwen 模型",
    enabled: true
  }
];
