import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const SQLITE_DB_PATH = path.join(dataDir, "chat-demo.sqlite");

// 当前项目共用一个 SQLite 文件：
// 对话列表、上传文档元数据、RAG chunk、FTS5 关键词索引、长期记忆和 LangGraph 短期记忆都放这里。
export const sqliteDb = new Database(SQLITE_DB_PATH);
sqliteDb.pragma("journal_mode = WAL");
sqliteDb.pragma("foreign_keys = ON");

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT NOT NULL,
    preference_type TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (user_id, preference_type)
  );

  CREATE TABLE IF NOT EXISTS chat_threads (
    thread_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    reasoning_effort TEXT,
    title TEXT NOT NULL,
    last_message_preview TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chat_threads_user_updated
  ON chat_threads(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS uploaded_documents (
    thread_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    file_id TEXT,
    file_name TEXT NOT NULL,
    original_name TEXT,
    storage_key TEXT,
    mime_type TEXT,
    file_type TEXT NOT NULL,
    file_size INTEGER,
    text TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    parse_status TEXT,
    index_status TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_uploaded_documents_user_thread
  ON uploaded_documents(user_id, thread_id);

  CREATE TABLE IF NOT EXISTS document_chunks (
    thread_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    embedding_json TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    built_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, chunk_index),
    FOREIGN KEY (thread_id) REFERENCES uploaded_documents(thread_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_document_chunks_thread
  ON document_chunks(thread_id, chunk_index);

  CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
    thread_id UNINDEXED,
    chunk_index UNINDEXED,
    content,
    tokenize = 'unicode61'
  );

  CREATE TABLE IF NOT EXISTS document_qa_messages (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    attachment_name TEXT,
    attachment_file_id TEXT,
    sources_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_document_qa_messages_thread_created
  ON document_qa_messages(thread_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS knowledge_base_documents (
    document_id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL,
    version TEXT,
    file_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    text_length INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    parse_status TEXT NOT NULL,
    index_status TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_base_documents_base
  ON knowledge_base_documents(knowledge_base_id, version);
`);

function addColumnIfMissing(
  tableName: string,
  columnName: string,
  definition: string
): void {
  // 轻量迁移：老数据库启动时自动补新列，避免学习项目每次改表都要手动删库。
  const rows = sqliteDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;

  if (rows.some((row) => row.name === columnName)) {
    return;
  }

  sqliteDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

for (const [columnName, definition] of [
  ["file_id", "TEXT"],
  ["original_name", "TEXT"],
  ["storage_key", "TEXT"],
  ["mime_type", "TEXT"],
  ["file_size", "INTEGER"],
  ["parse_status", "TEXT"],
  ["index_status", "TEXT"]
] as const) {
  addColumnIfMissing("uploaded_documents", columnName, definition);
}

sqliteDb.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_documents_file_id
  ON uploaded_documents(file_id)
  WHERE file_id IS NOT NULL;
`);

// LangGraph 短期记忆使用 SQLite Checkpointer，项目重启后仍可恢复 thread state。
export const sqliteCheckpointer = SqliteSaver.fromConnString(SQLITE_DB_PATH);
