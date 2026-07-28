import { sqliteDb } from "../db/sqlite";
import type {
  VectorDocumentIndex,
  VectorStore,
  VectorStoreSearchResult
} from "./vectorStore";

type DocumentChunkRow = {
  thread_id: string;
  chunk_index: number;
  content: string;
  char_count: number;
  start_char: number;
  end_char: number;
  source_type: "text" | "table" | "image_ocr" | "image_summary";
  page_number: number | null;
  block_index: number;
  locator: string;
  embedding_json: string;
  dimensions: number;
  built_at: string;
};

type FtsSearchRow = {
  chunk_index: number;
  rank: number;
};

// 学习点：SQLite 在当前项目里做两件事：
// 1. 持久化保存 chunk + embedding，保证重启后索引不丢。
// 2. 使用 FTS5/BM25 做关键词检索，给 Hybrid RAG 提供非向量信号。
export class SQLiteVectorStore implements VectorStore {
  saveIndex(index: VectorDocumentIndex): void {
    const insertChunk = sqliteDb.prepare(
      `
        INSERT INTO document_chunks (
          thread_id,
          chunk_index,
          content,
          char_count,
          start_char,
          end_char,
          source_type,
          page_number,
          block_index,
          locator,
          embedding_json,
          dimensions,
          built_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, chunk_index) DO UPDATE SET
          content = excluded.content,
          char_count = excluded.char_count,
          start_char = excluded.start_char,
          end_char = excluded.end_char,
          source_type = excluded.source_type,
          page_number = excluded.page_number,
          block_index = excluded.block_index,
          locator = excluded.locator,
          embedding_json = excluded.embedding_json,
          dimensions = excluded.dimensions,
          built_at = excluded.built_at
      `
    );
    const insertFtsChunk = sqliteDb.prepare(
      `
        INSERT INTO document_chunks_fts (
          thread_id,
          chunk_index,
          content
        ) VALUES (?, ?, ?)
      `
    );

    const saveChunks = sqliteDb.transaction(() => {
      // 学习点：重建索引前先清掉旧 chunk，避免同一个 thread 新旧文件混在一起。
      this.clearIndex(index.threadId);

      for (const chunk of index.chunks) {
        insertChunk.run(
          index.threadId,
          chunk.index,
          chunk.content,
          chunk.charCount,
          chunk.startChar,
          chunk.endChar,
          chunk.sourceType,
          chunk.pageNumber,
          chunk.blockIndex,
          chunk.locator,
          JSON.stringify(chunk.embedding),
          index.dimensions,
          index.builtAt
        );
        insertFtsChunk.run(index.threadId, chunk.index, chunk.content);
      }
    });

    saveChunks();
  }

  loadIndex(threadId: string): VectorDocumentIndex | null {
    // 学习点：项目重启后，内存 Map 没了，但可以从 SQLite 把索引读回来。
    const rows = sqliteDb
      .prepare(
        `
          SELECT
            thread_id,
            chunk_index,
            content,
            char_count,
            start_char,
            end_char,
            source_type,
            page_number,
            block_index,
            locator,
            embedding_json,
            dimensions,
            built_at
          FROM document_chunks
          WHERE thread_id = ?
          ORDER BY chunk_index ASC
        `
      )
      .all(threadId) as DocumentChunkRow[];

    if (rows.length === 0) {
      return null;
    }

    const firstRow = rows[0];
    return {
      threadId,
      userId: "",
      fileName: "",
      builtAt: firstRow.built_at,
      dimensions: firstRow.dimensions,
      chunkCount: rows.length,
      chunks: rows.map((row) => ({
        index: row.chunk_index,
        content: row.content,
        charCount: row.char_count,
        startChar: row.start_char,
        endChar: row.end_char,
        sourceType: row.source_type || "text",
        pageNumber: row.page_number,
        blockIndex: row.block_index ?? row.chunk_index,
        locator:
          row.locator ||
          `type=${row.source_type || "text"}; page=unknown; block=${
            row.block_index ?? row.chunk_index
          }; chars=${row.start_char}-${row.end_char}`,
        embedding: JSON.parse(row.embedding_json) as number[]
      }))
    };
  }

  clearIndex(threadId: string): void {
    sqliteDb.prepare("DELETE FROM document_chunks_fts WHERE thread_id = ?").run(threadId);
    sqliteDb.prepare("DELETE FROM document_chunks WHERE thread_id = ?").run(threadId);
  }

  async searchVectorScores(
    index: VectorDocumentIndex,
    queryEmbedding: number[],
    limit: number
  ): Promise<VectorStoreSearchResult> {
    // 学习点：SQLite fallback 没有真正的向量索引。
    // 数据少时可以遍历 chunk 算余弦相似度；数据大时应该交给 Chroma/Qdrant。
    const scores = index.chunks
      .map((chunk) => ({
        chunkIndex: chunk.index,
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.chunkIndex - right.chunkIndex;
      })
      .slice(0, limit);

    return {
      index,
      scores: new Map(scores.map((score) => [score.chunkIndex, score.score]))
    };
  }

  searchKeywordScores(threadId: string, query: string, limit: number): Map<number, number> {
    if (!query) {
      return new Map();
    }

    try {
      const rows = sqliteDb
        .prepare(
          `
            SELECT
              chunk_index,
              bm25(document_chunks_fts) AS rank
            FROM document_chunks_fts
            WHERE thread_id = ?
              AND document_chunks_fts MATCH ?
            ORDER BY rank ASC
            LIMIT ?
          `
        )
        .all(threadId, query, limit) as FtsSearchRow[];

      if (!rows.length) {
        return new Map();
      }

      const bestRank = Math.min(...rows.map((row) => row.rank));
      const worstRank = Math.max(...rows.map((row) => row.rank));
      const range = worstRank - bestRank || 1;

      // 学习点：SQLite bm25 分数越小越相关。
      // 这里转成 0-1，并统一成“越大越相关”，方便和向量分数融合。
      return new Map(
        rows.map((row) => [
          row.chunk_index,
          Number((1 - (row.rank - bestRank) / range).toFixed(6))
        ])
      );
    } catch {
      return new Map();
    }
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dotProduct = 0;

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
  }

  return Number(dotProduct.toFixed(6));
}

export const sqliteVectorStore = new SQLiteVectorStore();
