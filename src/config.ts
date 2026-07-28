/**
 * 统一读取环境变量，并声明前端可选择的模型目录。
 *
 * 学习点：配置集中在这里，业务代码就不用到处直接读取 process.env。
 * 这样后面切换 DeepSeek、OpenAI、SiliconFlow、Embedding 或向量库时，只改配置层即可。
 */
import dotenv from "dotenv";
import { ModelOption, ProviderConfig, ProviderId } from "./types";

dotenv.config();

export const appConfig = {
  // 学习点：服务监听地址和端口只影响本地 Web 服务，不影响模型 API 地址。
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  // 学习点：默认角色用于新对话初始化；前端仍然可以让用户手动切换角色。
  defaultRoleId: process.env.DEFAULT_ROLE_ID || "python-engineer",
  // 学习点：vectorStoreProvider 决定 RAG 向量索引写到哪里。
  // sqlite 最简单，Chroma 更接近真实向量数据库，但需要单独启动服务。
  vectorStoreProvider:
    (process.env.VECTOR_STORE_PROVIDER as "sqlite" | "chroma" | undefined) || "sqlite",
  chroma: {
    path: process.env.CHROMA_URL || "http://localhost:8000",
    collectionName: process.env.CHROMA_COLLECTION || "chat_demo_documents"
  },
  embedding: {
    // 学习点：Embedding 是把文本转成向量，RAG 用它来计算“问题和文档片段是否相似”。
    // hash 是本地学习兜底，不花钱；openai/siliconflow/compatible 是真实 Embedding 服务。
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
  },
  moonshot: {
    apiKey: process.env.MOONSHOT_API_KEY || "",
    apiUrl:
      process.env.MOONSHOT_API_URL ||
      "https://api.moonshot.ai/v1/chat/completions"
  }
};

export function getProviderConfig(providerId: ProviderId): ProviderConfig {
  return providerConfigs[providerId];
}

export const modelCatalog: ModelOption[] = [
  // 学习点：modelCatalog 是“前端能看到和选择的模型清单”。
  // provider 字段把模型和后端 Provider 绑定起来，真正调用时会按 provider 分发。
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
    id: "kimi-k2.6",
    label: "Kimi K2.6",
    provider: "moonshot",
    description: "Kimi 多模态模型，支持文本、图片理解和 Agent 任务",
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
