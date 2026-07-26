import { appConfig } from "../config";

const MIN_TOKEN_LENGTH = 2;

// 学习点：EmbeddingProvider 是“把文本变成向量”的统一接口。
// 后面无论接 hash、SiliconFlow 还是 OpenAI，RAG 代码都只依赖这个接口。
export interface EmbeddingProvider {
  id: string;
  embedText(text: string): Promise<number[]>;
  embedTexts(texts: string[]): Promise<number[][]>;
}

interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  error?: {
    message?: string;
  };
}

class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = "hash";

  constructor(private readonly dimensions: number) {}

  async embedText(text: string): Promise<number[]> {
    return this.embedOne(text);
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    // 学习点：hash embedding 是本地兜底方案，不需要 API Key。
    // 它不真正理解语义，只是把词打散到固定维度里，适合学习流程。
    const vector = new Array<number>(this.dimensions).fill(0);

    for (const token of extractTerms(text)) {
      const bucket = positiveHash(token) % this.dimensions;
      vector[bucket] += 1;
    }

    return normalizeVector(vector);
  }
}

class CompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;

  constructor(
    id: string,
    private readonly config: {
      apiKey: string;
      apiUrl: string;
      model: string;
    }
  ) {
    this.id = id;
  }

  async embedText(text: string): Promise<number[]> {
    const [embedding] = await this.embedTexts([text]);
    return embedding;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.config.apiKey) {
      throw new Error(
        `Embedding provider "${this.id}" is missing EMBEDDING_API_KEY.`
      );
    }

    // 学习点：真实 embedding 模型通过 OpenAI-compatible 接口调用。
    // 文档 chunk 和用户问题都要先变成向量，后面才能比较语义相似度。
    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts
      })
    });
    const data = (await response.json()) as EmbeddingResponse;

    if (!response.ok) {
      throw new Error(
        data.error?.message || `Embedding request failed for "${this.id}".`
      );
    }

    const embeddings = data.data?.map((item) => item.embedding || []) || [];
    if (embeddings.length !== texts.length || embeddings.some((item) => item.length === 0)) {
      throw new Error(`Embedding provider "${this.id}" returned invalid embeddings.`);
    }

    return embeddings.map(normalizeVector);
  }
}

function createEmbeddingProvider(): EmbeddingProvider {
  const provider = appConfig.embedding.provider;

  if (provider === "hash") {
    // 学习点：没配置真实 embedding key 时，先用 hash 跑通完整 RAG 流程。
    return new HashEmbeddingProvider(appConfig.embedding.hashDimensions);
  }

  // 学习点：真实 embedding 模型由 .env 控制，当前项目可接 SiliconFlow 这类兼容接口。
  return new CompatibleEmbeddingProvider(provider, {
    apiKey: appConfig.embedding.apiKey,
    apiUrl:
      provider === "siliconflow" && !process.env.EMBEDDING_API_URL
        ? "https://api.siliconflow.cn/v1/embeddings"
        : appConfig.embedding.apiUrl,
    model: appConfig.embedding.model
  });
}

function extractTerms(text: string): string[] {
  // 学习点：这里给 hash embedding 做简单分词。
  // 英文按 token 抽取，中文用相邻两个字的 bigram 近似处理。
  const normalizedText = text.toLowerCase();
  const latinTerms = normalizedText.match(/[a-z0-9_+-]{2,}/g) ?? [];
  const cjkText = normalizedText.replace(/[^\u4e00-\u9fff]/g, "");
  const cjkTerms: string[] = [];

  for (let index = 0; index < cjkText.length - 1; index += 1) {
    cjkTerms.push(cjkText.slice(index, index + 2));
  }

  return [...latinTerms, ...cjkTerms].filter(
    (term) => term.length >= MIN_TOKEN_LENGTH
  );
}

function positiveHash(value: string): number {
  // 学习点：hash 的作用是把一个词稳定映射到某个向量位置。
  // 同一个词每次都会落到同一个 bucket，才能形成可比较的向量。
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function normalizeVector(vector: number[]): number[] {
  // 学习点：归一化后，向量长度变成 1。
  // 后面用点积计算相似度时，不会被文本长短影响太多。
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0)
  );

  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

export const embeddingProvider = createEmbeddingProvider();
