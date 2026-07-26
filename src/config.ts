/**
 * 统一读取环境变量，并声明前端可选择的模型目录。
 */
import dotenv from "dotenv";
import { ModelOption, ProviderConfig, ProviderId } from "./types";

dotenv.config();

export const appConfig = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  defaultRoleId: process.env.DEFAULT_ROLE_ID || "python-engineer",
  vectorStoreProvider:
    (process.env.VECTOR_STORE_PROVIDER as "sqlite" | "chroma" | undefined) || "sqlite",
  chroma: {
    path: process.env.CHROMA_URL || "http://localhost:8000",
    collectionName: process.env.CHROMA_COLLECTION || "chat_demo_documents"
  },
  embedding: {
    provider:
      (process.env.EMBEDDING_PROVIDER as
        | "hash"
        | "openai"
        | "siliconflow"
        | "compatible"
        | undefined) || "hash",
    model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    apiKey:
      process.env.EMBEDDING_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.SILICONFLOW_API_KEY ||
      "",
    apiUrl:
      process.env.EMBEDDING_API_URL ||
      process.env.OPENAI_EMBEDDING_API_URL ||
      "https://api.openai.com/v1/embeddings",
    hashDimensions: Number(process.env.HASH_EMBEDDING_DIMENSIONS || 384)
  }
};

const providerConfigs: Record<ProviderId, ProviderConfig> = {
  // API Key 只保存在服务端，不会通过模型列表接口返回前端。
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    apiUrl:
      process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions"
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    apiUrl:
      process.env.OPENAI_API_URL ||
      "https://api.openai.com/v1/responses",
    reasoningEffort:
      (process.env.OPENAI_REASONING_EFFORT as
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | undefined) || "low"
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
    supportsVision: true,
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
