import type { DocumentChunk } from "./documentChunkLab";

// 学习点：普通 chunk 只是文本片段。
// 加上 embedding 后，它才具备“可以被向量检索”的能力。
export interface VectorIndexedChunk extends DocumentChunk {
  embedding: number[];
}

// 学习点：一个文档索引就是“这个文档所有 chunk + 每个 chunk 的向量”。
// threadId 用来把索引和某个对话/知识库文档绑定起来。
export interface VectorDocumentIndex {
  threadId: string;
  userId: string;
  fileName: string;
  builtAt: string;
  dimensions: number;
  chunkCount: number;
  chunks: VectorIndexedChunk[];
}

export interface VectorStoreSearchResult {
  index: VectorDocumentIndex;
  scores: Map<number, number>;
}

// 学习点：VectorStore 是向量数据库的统一接口。
// 上层 RAG 只调用这个接口，不需要关心底层到底是 Chroma 还是 SQLite fallback。
export interface VectorStore {
  saveIndex(index: VectorDocumentIndex): void | Promise<void>;
  loadIndex(threadId: string): VectorDocumentIndex | null;
  clearIndex(threadId: string): void;
  searchVectorScores(
    index: VectorDocumentIndex,
    queryEmbedding: number[],
    limit: number
  ): Promise<VectorStoreSearchResult>;
  searchKeywordScores(threadId: string, query: string, limit: number): Map<number, number>;
}
