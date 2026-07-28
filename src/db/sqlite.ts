import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const SQLITE_DB_PATH = path.join(dataDir, "chat-demo.sqlite");

// 学习点：SQLite 是当前项目的“结构化数据中心”。
// 原始文件本体放磁盘目录，数据库主要保存记录、索引、状态和记忆。
// 当前项目共用一个 SQLite 文件：
// 对话列表、上传文档元数据、RAG chunk、FTS5 关键词索引、长期记忆和 LangGraph 短期记忆都放这里。
export const sqliteDb = new Database(SQLITE_DB_PATH);
// 学习点：WAL 模式能减少读写互相阻塞，适合聊天项目这种边读历史边写消息的场景。
sqliteDb.pragma("journal_mode = WAL");
// 学习点：开启外键后，删除对话或文档时，关联 chunk 可以按规则一起清理。
sqliteDb.pragma("foreign_keys = ON");

sqliteDb.exec(`
  -- 学习点：长期记忆表，保存跨 thread 的用户偏好，例如“喜欢深色主题”。
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT NOT NULL,
    preference_type TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (user_id, preference_type)
  );

  -- 学习点：对话列表表，左侧历史会从这里读取。
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

  -- 学习点：上传文档元数据表，只保存文件路径、解析文本和索引状态。
  -- 原始 PDF/PPT/图片文件不直接塞进数据库，而是放在 data/uploads。
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

  -- 学习点：RAG chunk 表，保存切分后的文本片段和 embedding。
  -- SQLite 向量模式会用这里恢复索引，Chroma 模式则主要由 Chroma 保存向量。
  CREATE TABLE IF NOT EXISTS document_chunks (
    thread_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'text',
    page_number INTEGER,
    block_index INTEGER NOT NULL DEFAULT 0,
    locator TEXT NOT NULL DEFAULT '',
    embedding_json TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    built_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, chunk_index),
    FOREIGN KEY (thread_id) REFERENCES uploaded_documents(thread_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_document_chunks_thread
  ON document_chunks(thread_id, chunk_index);

  -- 学习点：FTS5 是 SQLite 的全文检索能力。
  -- Hybrid RAG 用它做 BM25/关键词检索，弥补纯向量检索对编号、术语、代码不敏感的问题。
  CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
    thread_id UNINDEXED,
    chunk_index UNINDEXED,
    content,
    tokenize = 'unicode61'
  );

  -- 学习点：文档问答消息单独存一张表，便于刷新页面后恢复“带附件的问答记录”。
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

  -- 学习点：知识库文档表保存长期资料库的文档清单和索引状态。
  -- 它记录“有哪些资料可检索”，实际 chunk 仍复用 RAG 索引表/向量库。
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

for (const [columnName, definition] of [
  ["source_type", "TEXT NOT NULL DEFAULT 'text'"],
  ["page_number", "INTEGER"],
  ["block_index", "INTEGER NOT NULL DEFAULT 0"],
  ["locator", "TEXT NOT NULL DEFAULT ''"]
] as const) {
  // 学习点：这些是 chunk 的位置元数据。
  // 为什么这样：后续 PDF 表格/图片、页码引用、段落定位都依赖这些字段。
  addColumnIfMissing("document_chunks", columnName, definition);
}

sqliteDb.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_documents_file_id
  ON uploaded_documents(file_id)
  WHERE file_id IS NOT NULL;
`);

// LangGraph 短期记忆使用 SQLite Checkpointer，项目重启后仍可恢复 thread state。
export const sqliteCheckpointer = SqliteSaver.fromConnString(SQLITE_DB_PATH);
