import { sqliteDb } from "../db/sqlite";

export interface KnowledgeBaseDocumentRecord {
  documentId: string;
  knowledgeBaseId: string;
  version: string;
  fileName: string;
  storageKey: string;
  fileType: string;
  fileSize: number;
  textLength: number;
  chunkCount: number;
  parseStatus: string;
  indexStatus: string;
  indexedAt: string;
}

export function saveKnowledgeBaseDocument(
  record: KnowledgeBaseDocumentRecord
): void {
  // 学习点：knowledge_base_documents 只保存知识库文档的“索引状态和元数据”。
  // 原文件仍在 data/knowledge-bases，chunk/embedding 仍在 vector store。
  sqliteDb
    .prepare(
      `
        INSERT INTO knowledge_base_documents (
          document_id,
          knowledge_base_id,
          version,
          file_name,
          storage_key,
          file_type,
          file_size,
          text_length,
          chunk_count,
          parse_status,
          index_status,
          indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          knowledge_base_id = excluded.knowledge_base_id,
          version = excluded.version,
          file_name = excluded.file_name,
          storage_key = excluded.storage_key,
          file_type = excluded.file_type,
          file_size = excluded.file_size,
          text_length = excluded.text_length,
          chunk_count = excluded.chunk_count,
          parse_status = excluded.parse_status,
          index_status = excluded.index_status,
          indexed_at = excluded.indexed_at
      `
    )
    .run(
      record.documentId,
      record.knowledgeBaseId,
      record.version,
      record.fileName,
      record.storageKey,
      record.fileType,
      record.fileSize,
      record.textLength,
      record.chunkCount,
      record.parseStatus,
      record.indexStatus,
      record.indexedAt
    );
}

type KnowledgeBaseDocumentRow = {
  document_id: string;
  knowledge_base_id: string;
  version: string | null;
  file_name: string;
  storage_key: string;
  file_type: string;
  file_size: number;
  text_length: number;
  chunk_count: number;
  parse_status: string;
  index_status: string;
  indexed_at: string;
};

export function listKnowledgeBaseDocuments(
  knowledgeBaseId: string
): KnowledgeBaseDocumentRecord[] {
  // 学习点：问答时只读取已经 parsed + indexed 的文档。
  // 解析失败或还没索引的文件不会进入检索结果。
  const rows = sqliteDb
    .prepare(
      `
        SELECT
          document_id,
          knowledge_base_id,
          version,
          file_name,
          storage_key,
          file_type,
          file_size,
          text_length,
          chunk_count,
          parse_status,
          index_status,
          indexed_at
        FROM knowledge_base_documents
        WHERE knowledge_base_id = ?
          AND parse_status = 'parsed'
          AND index_status = 'indexed'
        ORDER BY version ASC, file_name ASC
      `
    )
    .all(knowledgeBaseId) as KnowledgeBaseDocumentRow[];

  return rows.map((row) => ({
    documentId: row.document_id,
    knowledgeBaseId: row.knowledge_base_id,
    version: row.version || "",
    fileName: row.file_name,
    storageKey: row.storage_key,
    fileType: row.file_type,
    fileSize: row.file_size,
    textLength: row.text_length,
    chunkCount: row.chunk_count,
    parseStatus: row.parse_status,
    indexStatus: row.index_status,
    indexedAt: row.indexed_at
  }));
}
