import {
  DocumentChunk,
  RAG_RETRIEVAL_CONFIG,
  splitUploadedDocument
} from "./documentChunkLab";
import { sqliteDb } from "../db/sqlite";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";

const VECTOR_DIMENSIONS = 384;
const MIN_TOKEN_LENGTH = 2;

export interface VectorIndexedChunk extends DocumentChunk {
  embedding: number[];
}

export interface VectorDocumentIndex {
  threadId: string;
  userId: string;
  fileName: string;
  builtAt: string;
  dimensions: number;
  chunkCount: number;
  chunks: VectorIndexedChunk[];
}

export interface VectorSearchChunk extends VectorIndexedChunk {
  similarity: number;
  matchedTerms: string[];
}

const indexByThread = new Map<string, VectorDocumentIndex>();

type DocumentChunkRow = {
  thread_id: string;
  chunk_index: number;
  content: string;
  char_count: number;
  start_char: number;
  end_char: number;
  embedding_json: string;
  dimensions: number;
  built_at: string;
};

/**
 * Builds and caches a small in-memory vector index for one uploaded document.
 * The embedding is local hashing-based vectorization, so it works without an
 * external embedding API and can later be swapped for a real embedding model.
 */
export async function buildVectorDocumentIndex(
  document: UploadedDocumentRecord
): Promise<VectorDocumentIndex> {
  const chunks = await splitUploadedDocument(document);
  const builtAt = new Date().toISOString();
  const index: VectorDocumentIndex = {
    threadId: document.threadId,
    userId: document.userId,
    fileName: document.fileName,
    builtAt,
    dimensions: VECTOR_DIMENSIONS,
    chunkCount: chunks.length,
    chunks: chunks.map((chunk) => ({
      ...chunk,
      embedding: embedText(chunk.content)
    }))
  };

  indexByThread.set(document.threadId, index);
  saveVectorDocumentIndex(index);
  markVectorIndexPersisted(document.threadId);
  return index;
}

export function clearVectorDocumentIndex(threadId: string): void {
  indexByThread.delete(threadId);
}

export async function getOrBuildVectorDocumentIndex(
  document: UploadedDocumentRecord
): Promise<VectorDocumentIndex> {
  const existingIndex = indexByThread.get(document.threadId);

  if (
    existingIndex &&
    existingIndex.fileName === document.fileName &&
    existingIndex.userId === document.userId
  ) {
    return existingIndex;
  }

  const persistedIndex = getPersistedVectorDocumentIndex(document);
  if (persistedIndex) {
    indexByThread.set(document.threadId, persistedIndex);
    return persistedIndex;
  }

  return buildVectorDocumentIndex(document);
}

export async function searchVectorDocumentIndex(
  document: UploadedDocumentRecord,
  query: string
): Promise<{
  index: VectorDocumentIndex;
  queryEmbedding: number[];
  chunks: VectorSearchChunk[];
}> {
  const index = await getOrBuildVectorDocumentIndex(document);
  const queryEmbedding = embedText(query);
  const queryTerms = extractTerms(query);
  const rankedChunks = index.chunks
    .map((chunk) => ({
      ...chunk,
      similarity: cosineSimilarity(queryEmbedding, chunk.embedding),
      matchedTerms: getMatchedTerms(chunk.content, queryTerms)
    }))
    .sort((left, right) => {
      if (right.similarity !== left.similarity) {
        return right.similarity - left.similarity;
      }

      return left.index - right.index;
    });

  return {
    index,
    queryEmbedding,
    chunks: rankedChunks.slice(0, RAG_RETRIEVAL_CONFIG.topK)
  };
}

function embedText(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);

  for (const token of extractTerms(text)) {
    const bucket = positiveHash(token) % VECTOR_DIMENSIONS;
    vector[bucket] += 1;
  }

  return normalizeVector(vector);
}

function saveVectorDocumentIndex(index: VectorDocumentIndex): void {
  const insertChunk = sqliteDb.prepare(
    `
      INSERT INTO document_chunks (
        thread_id,
        chunk_index,
        content,
        char_count,
        start_char,
        end_char,
        embedding_json,
        dimensions,
        built_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, chunk_index) DO UPDATE SET
        content = excluded.content,
        char_count = excluded.char_count,
        start_char = excluded.start_char,
        end_char = excluded.end_char,
        embedding_json = excluded.embedding_json,
        dimensions = excluded.dimensions,
        built_at = excluded.built_at
    `
  );

  const saveChunks = sqliteDb.transaction(() => {
    sqliteDb
      .prepare("DELETE FROM document_chunks WHERE thread_id = ?")
      .run(index.threadId);

    for (const chunk of index.chunks) {
      insertChunk.run(
        index.threadId,
        chunk.index,
        chunk.content,
        chunk.charCount,
        chunk.startChar,
        chunk.endChar,
        JSON.stringify(chunk.embedding),
        index.dimensions,
        index.builtAt
      );
    }
  });

  saveChunks();
}

function getPersistedVectorDocumentIndex(
  document: UploadedDocumentRecord
): VectorDocumentIndex | null {
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
          embedding_json,
          dimensions,
          built_at
        FROM document_chunks
        WHERE thread_id = ?
        ORDER BY chunk_index ASC
      `
    )
    .all(document.threadId) as DocumentChunkRow[];

  if (rows.length === 0) {
    return null;
  }

  const firstRow = rows[0];

  return {
    threadId: document.threadId,
    userId: document.userId,
    fileName: document.fileName,
    builtAt: firstRow.built_at,
    dimensions: firstRow.dimensions,
    chunkCount: rows.length,
    chunks: rows.map((row) => ({
      index: row.chunk_index,
      content: row.content,
      charCount: row.char_count,
      startChar: row.start_char,
      endChar: row.end_char,
      embedding: JSON.parse(row.embedding_json) as number[]
    }))
  };
}

function markVectorIndexPersisted(threadId: string): void {
  sqliteDb
    .prepare(
      `
        UPDATE uploaded_documents
        SET index_status = 'indexed'
        WHERE thread_id = ?
      `
    )
    .run(threadId);
}

function extractTerms(text: string): string[] {
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

function getMatchedTerms(content: string, queryTerms: string[]): string[] {
  const normalizedContent = content.toLowerCase();
  return [...new Set(queryTerms.filter((term) => normalizedContent.includes(term)))].slice(
    0,
    RAG_RETRIEVAL_CONFIG.maxQueryTerms
  );
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dotProduct = 0;

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
  }

  return Number(dotProduct.toFixed(6));
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0)
  );

  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function positiveHash(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}
