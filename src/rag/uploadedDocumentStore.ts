import { sqliteDb } from "../db/sqlite";
import { clearVectorDocumentIndex } from "./vectorDocumentIndex";
import type { StoredLangChainDocument } from "./langChainDocumentLoader";

export interface UploadedDocumentRecord {
  threadId: string;
  userId: string;
  fileId: string;
  fileName: string;
  originalName: string;
  storageKey: string;
  mimeType: string;
  fileType:
    | "markdown"
    | "pdf"
    | "text"
    | "presentation"
    | "word"
    | "spreadsheet"
    | "html"
    | "image"
    | "binary";
  fileSize: number;
  text: string;
  loaderDocuments: StoredLangChainDocument[];
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
  loader_documents_json: string | null;
  uploaded_at: string;
  parse_status: UploadedDocumentRecord["parseStatus"] | null;
  index_status: UploadedDocumentRecord["indexStatus"] | null;
};

export function saveUploadedDocument(record: UploadedDocumentRecord): void {
  // 学习点：uploaded_documents 保存“当前 thread 绑定了哪份文档”。
  // 文件本体不进数据库，只保存 storageKey；可检索文本会保存，方便后续切分和重建索引。
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
          loader_documents_json,
          uploaded_at,
          parse_status,
          index_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          loader_documents_json = excluded.loader_documents_json,
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
      JSON.stringify(record.loaderDocuments),
      record.uploadedAt,
      record.parseStatus,
      record.indexStatus
    );

  // 学习点：同一个 thread 上传新文件时，旧 chunk 和旧 embedding 必须失效。
  clearVectorDocumentIndex(record.threadId);
}

export function getUploadedDocument(
  threadId: string
): UploadedDocumentRecord | undefined {
  // 学习点：普通上传文件问答按 threadId 查文档。
  // 当前对话上传的文件，只影响当前对话。
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
          loader_documents_json,
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

  return mapUploadedDocumentRow(row);
}

export function getUploadedDocumentByFileId(
  fileId: string,
  userId: string
): UploadedDocumentRecord | undefined {
  // 学习点：文件预览/下载按 fileId 查，同时校验 userId，避免跨用户读取。
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
          loader_documents_json,
          uploaded_at,
          parse_status,
          index_status
        FROM uploaded_documents
        WHERE file_id = ? AND user_id = ?
      `
    )
    .get(fileId, userId) as UploadedDocumentRow | undefined;

  if (!row) {
    return undefined;
  }

  return mapUploadedDocumentRow(row);
}

function mapUploadedDocumentRow(row: UploadedDocumentRow): UploadedDocumentRecord {
  // 学习点：数据库字段是 snake_case，TypeScript 代码里统一转成 camelCase。
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
    loaderDocuments: parseLoaderDocuments(row.loader_documents_json),
    uploadedAt: row.uploaded_at,
    parseStatus: row.parse_status || (row.text ? "parsed" : "unsupported"),
    indexStatus: row.index_status || "pending"
  };
}

function parseLoaderDocuments(
  value: string | null
): StoredLangChainDocument[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as StoredLangChainDocument[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 旧记录或损坏元数据不阻止文档问答，切分层会回退到 text 字段。
    return [];
  }
}
