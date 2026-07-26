import { ChromaClient, type Collection } from "chromadb";
import { appConfig } from "../config";
import { sqliteVectorStore } from "./sqliteVectorStore";
import type {
  VectorDocumentIndex,
  VectorStore,
  VectorStoreSearchResult
} from "./vectorStore";

type ChunkMetadata = {
  threadId: string;
  userId: string;
  fileName: string;
  chunkIndex: number;
  charCount: number;
  startChar: number;
  endChar: number;
  builtAt: string;
  dimensions: number;
};

/**
 * 学习点：Chroma 是当前项目的向量数据库实现。
 *
 * Chroma 负责真正的向量相似度检索。
 * SQLite 仍然保留一份 chunk、元数据和 FTS5 关键词索引，用于恢复和 fallback。
 */
export class ChromaVectorStore implements VectorStore {
  private readonly client = new ChromaClient({ path: appConfig.chroma.path });
  private collectionPromise: Promise<Collection> | null = null;

  async saveIndex(index: VectorDocumentIndex): Promise<void> {
    // 学习点：先写 SQLite，保证即使 Chroma 没启动，项目也有本地兜底数据。
    sqliteVectorStore.saveIndex(index);
    // 学习点：再写 Chroma，用于后续更快、更标准的向量检索。
    await this.upsertIndex(index);
  }

  loadIndex(threadId: string): VectorDocumentIndex | null {
    // 学习点：完整 chunk 内容从 SQLite 恢复，Chroma 主要负责向量搜索。
    return sqliteVectorStore.loadIndex(threadId);
  }

  clearIndex(threadId: string): void {
    // 学习点：删除对话/替换文件时，SQLite 和 Chroma 都要清理，避免旧 chunk 污染答案。
    sqliteVectorStore.clearIndex(threadId);
    void this.deleteThread(threadId);
  }

  async searchVectorScores(
    index: VectorDocumentIndex,
    queryEmbedding: number[],
    limit: number
  ): Promise<VectorStoreSearchResult> {
    try {
      const collection = await this.getCollection();
      // 学习点：Chroma 返回的是 distance，这里转成 score。
      // score 统一成“越大越相关”，后面才能和 BM25 分数融合。
      const result = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: limit,
        where: { threadId: index.threadId },
        include: ["distances", "metadatas"]
      });
      const scores = new Map<number, number>();

      for (const row of result.rows()[0] ?? []) {
        const metadata = row.metadata as Partial<ChunkMetadata> | undefined;
        const chunkIndex = Number(metadata?.chunkIndex);

        if (!Number.isFinite(chunkIndex)) {
          continue;
        }

        scores.set(chunkIndex, normalizeDistance(row.distance));
      }

      if (scores.size > 0) {
        return { index, scores };
      }
    } catch (error) {
      console.warn("Chroma vector search failed, falling back to SQLite:", error);
    }

    // 学习点：Chroma 不可用时，自动退回 SQLite 本地余弦相似度。
    return sqliteVectorStore.searchVectorScores(index, queryEmbedding, limit);
  }

  searchKeywordScores(threadId: string, query: string, limit: number): Map<number, number> {
    return sqliteVectorStore.searchKeywordScores(threadId, query, limit);
  }

  private getCollection(): Promise<Collection> {
    if (!this.collectionPromise) {
      // 学习点：collection 只创建/连接一次，后续重复使用。
      this.collectionPromise = this.client.getOrCreateCollection({
        name: appConfig.chroma.collectionName,
        embeddingFunction: null,
        metadata: {
          description: "ChatDemo uploaded document chunks"
        }
      });
    }

    return this.collectionPromise;
  }

  private async upsertIndex(index: VectorDocumentIndex): Promise<void> {
    try {
      const collection = await this.getCollection();
      // 学习点：同一个 thread 只保留最新索引。
      // 先删后写，可以避免旧文件的 chunk 残留在检索结果里。
      await collection.delete({ where: { threadId: index.threadId } }).catch(() => undefined);
      await collection.upsert({
        ids: index.chunks.map((chunk) => buildChunkId(index.threadId, chunk.index)),
        embeddings: index.chunks.map((chunk) => chunk.embedding),
        documents: index.chunks.map((chunk) => chunk.content),
        metadatas: index.chunks.map((chunk) => ({
          threadId: index.threadId,
          userId: index.userId,
          fileName: index.fileName,
          chunkIndex: chunk.index,
          charCount: chunk.charCount,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
          builtAt: index.builtAt,
          dimensions: index.dimensions
        }))
      });
    } catch (error) {
      console.warn("Chroma index save failed, SQLite fallback remains available:", error);
    }
  }

  private async deleteThread(threadId: string): Promise<void> {
    try {
      const collection = await this.getCollection();
      await collection.delete({ where: { threadId } });
    } catch (error) {
      console.warn("Chroma index delete failed:", error);
    }
  }
}

function buildChunkId(threadId: string, chunkIndex: number): string {
  return `${threadId}:${chunkIndex}`;
}

function normalizeDistance(distance: number | null | undefined): number {
  if (typeof distance !== "number" || !Number.isFinite(distance)) {
    return 0;
  }

  return Number((1 / (1 + Math.max(distance, 0))).toFixed(6));
}

export const chromaVectorStore = new ChromaVectorStore();
