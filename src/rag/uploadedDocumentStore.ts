import { sqliteDb } from "../db/sqlite";
import { clearVectorDocumentIndex } from "./vectorDocumentIndex";

export interface UploadedDocumentRecord {
  threadId: string;
  userId: string;
  fileId: string;
  fileName: string;
  originalName: string;
  storageKey: string;
  mimeType: string;
  fileType: "markdown" | "pdf" | "text" | "presentation" | "image" | "binary";
  fileSize: number;
  text: string;
  uploadedAt: string;
  parseStatus: "parsed" | "unsupported" | "empty";
  indexStatus: "pending" | "indexed" | "unsupported";
}

type UploadedDocumentRow = {
  thread_id: string;
  user_id: string;
  file_id: string | null;
  file_name: string;
  original_name: string | null;
  storage_key: string | null;
  mime_type: string | null;
  file_type: UploadedDocumentRecord["fileType"];
  file_size: number | null;
  text: string;
  uploaded_at: string;
  parse_status: UploadedDocumentRecord["parseStatus"] | null;
  index_status: UploadedDocumentRecord["indexStatus"] | null;
};

export function saveUploadedDocument(record: UploadedDocumentRecord): void {
  sqliteDb
    .prepare(
      `
        INSERT INTO uploaded_documents (
          thread_id,
          user_id,
          file_id,
          file_name,
          original_name,
          storage_key,
          mime_type,
          file_type,
          file_size,
          text,
          uploaded_at,
          parse_status,
          index_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          user_id = excluded.user_id,
          file_id = excluded.file_id,
          file_name = excluded.file_name,
          original_name = excluded.original_name,
          storage_key = excluded.storage_key,
          mime_type = excluded.mime_type,
          file_type = excluded.file_type,
          file_size = excluded.file_size,
          text = excluded.text,
          uploaded_at = excluded.uploaded_at,
          parse_status = excluded.parse_status,
          index_status = excluded.index_status
      `
    )
    .run(
      record.threadId,
      record.userId,
      record.fileId,
      record.fileName,
      record.originalName,
      record.storageKey,
      record.mimeType,
      record.fileType,
      record.fileSize,
      record.text,
      record.uploadedAt,
      record.parseStatus,
      record.indexStatus
    );

  // 新文件替换当前 thread 的旧文档时，旧 chunks 和 embedding 必须失效。
  sqliteDb
    .prepare("DELETE FROM document_chunks WHERE thread_id = ?")
    .run(record.threadId);
  clearVectorDocumentIndex(record.threadId);
}

export function getUploadedDocument(
  threadId: string
): UploadedDocumentRecord | undefined {
  const row = sqliteDb
    .prepare(
      `
        SELECT
          thread_id,
          user_id,
          file_id,
          file_name,
          original_name,
          storage_key,
          mime_type,
          file_type,
          file_size,
          text,
          uploaded_at,
          parse_status,
          index_status
        FROM uploaded_documents
        WHERE thread_id = ?
      `
    )
    .get(threadId) as UploadedDocumentRow | undefined;

  if (!row) {
    return undefined;
  }

  return {
    threadId: row.thread_id,
    userId: row.user_id,
    fileId: row.file_id || "",
    fileName: row.file_name,
    originalName: row.original_name || row.file_name,
    storageKey: row.storage_key || "",
    mimeType: row.mime_type || "application/octet-stream",
    fileType: row.file_type,
    fileSize: row.file_size || 0,
    text: row.text,
    uploadedAt: row.uploaded_at,
    parseStatus: row.parse_status || (row.text ? "parsed" : "unsupported"),
    indexStatus: row.index_status || "pending"
  };
}
