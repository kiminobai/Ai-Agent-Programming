import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { hashPassword } from "../auth";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const SQLITE_DB_PATH = path.join(dataDir, "chat-demo.sqlite");

// SQLite 是当前项目的结构化数据中心：保存对话、文件元数据、RAG 索引、记忆和用户表。
export const sqliteDb = new Database(SQLITE_DB_PATH);
// WAL 模式能减少读写互相阻塞，适合聊天项目这种边读历史边写消息的场景。
sqliteDb.pragma("journal_mode = WAL");
// 开启外键后，删除对话或文档时，关联 chunk 可以按规则一起清理。
sqliteDb.pragma("foreign_keys = ON");

sqliteDb.exec(`
  -- Auth users table. Passwords are stored as hashes, never plain text.
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Long-term memory table: stores user preferences across threads.
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT NOT NULL,
    preference_type TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (user_id, preference_type)
  );

  -- Chat thread list used by the left sidebar.
  CREATE TABLE IF NOT EXISTS chat_threads (
    thread_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    reasoning_effort TEXT,
    mode TEXT NOT NULL DEFAULT 'chat',
    workspace_path TEXT,
    workspace_name TEXT,
    title TEXT NOT NULL,
    last_message_preview TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chat_threads_user_updated
  ON chat_threads(user_id, updated_at DESC);

  -- Coding Agent activity is persisted separately from chat text.
  -- The Work UI uses it to show changed files and command output after refresh.
  CREATE TABLE IF NOT EXISTS workspace_activity (
    activity_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    turn_id TEXT,
    activity_type TEXT NOT NULL,
    file_path TEXT,
    additions INTEGER,
    deletions INTEGER,
    command_text TEXT,
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_activity_thread_created
  ON workspace_activity(thread_id, created_at ASC);

  -- Uploaded document metadata. Raw files live on disk; SQLite stores paths and parse/index status.
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

  -- RAG chunks table. Stores split text, location metadata, and embedding fallback data.
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

  -- GraphRAG entity nodes extracted from chunks.
  CREATE TABLE IF NOT EXISTS document_graph_nodes (
    thread_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    chunk_indexes_json TEXT NOT NULL,
    mention_count INTEGER NOT NULL,
    built_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, entity),
    FOREIGN KEY (thread_id) REFERENCES uploaded_documents(thread_id)
      ON DELETE CASCADE
  );

  -- GraphRAG relation edges. This first version uses chunk co-occurrence as a lightweight relation.
  CREATE TABLE IF NOT EXISTS document_graph_edges (
    thread_id TEXT NOT NULL,
    source_entity TEXT NOT NULL,
    target_entity TEXT NOT NULL,
    relation TEXT NOT NULL,
    weight REAL NOT NULL,
    chunk_indexes_json TEXT NOT NULL,
    built_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, source_entity, target_entity, relation),
    FOREIGN KEY (thread_id) REFERENCES uploaded_documents(thread_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_document_graph_edges_thread_source
  ON document_graph_edges(thread_id, source_entity);

  -- FTS5 keyword index used by Hybrid RAG for BM25-style retrieval.
  CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
    thread_id UNINDEXED,
    chunk_index UNINDEXED,
    content,
    tokenize = 'unicode61'
  );

  -- Document QA history, used to restore attachment conversations after refresh.
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

  -- Knowledge base document list and indexing status.
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

for (const [columnName, definition] of [
  ["turn_id", "TEXT"],
  ["additions", "INTEGER"],
  ["deletions", "INTEGER"]
] as const) {
  addColumnIfMissing("workspace_activity", columnName, definition);
}

for (const [columnName, definition] of [
  ["mode", "TEXT NOT NULL DEFAULT 'chat'"],
  ["workspace_path", "TEXT"],
  ["workspace_name", "TEXT"]
] as const) {
  addColumnIfMissing("chat_threads", columnName, definition);
}

function addColumnIfMissing(
  tableName: string,
  columnName: string,
  definition: string
): void {
  // 轻量迁移：老数据库启动时自动补新列，避免每次改表都要手动删库。
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
  // 瀛︿範鐐癸細杩欎簺鏄?chunk 鐨勪綅缃厓鏁版嵁銆?  // 涓轰粈涔堣繖鏍凤細鍚庣画 PDF 琛ㄦ牸/鍥剧墖銆侀〉鐮佸紩鐢ㄣ€佹钀藉畾浣嶉兘渚濊禆杩欎簺瀛楁銆?  addColumnIfMissing("document_chunks", columnName, definition);
}

sqliteDb.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_documents_file_id
  ON uploaded_documents(file_id)
  WHERE file_id IS NOT NULL;
`);

// LangGraph 短期记忆使用 SQLite Checkpointer，项目重启后仍可恢复 thread state。
export const sqliteCheckpointer = SqliteSaver.fromConnString(SQLITE_DB_PATH);

export type DbUser = {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  created_at: string;
  updated_at: string;
};

function mapUserRow(row: UserRow | undefined): DbUser | undefined {
  if (!row) {
    return undefined;
  }

  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function seedDefaultAdminUser(): void {
  // 默认用户只在第一次启动时创建，避免后续修改密码或新增用户被覆盖。
  const existing = sqliteDb
    .prepare("SELECT id FROM users WHERE username = ?")
    .get("admin") as { id: string } | undefined;

  if (existing) {
    return;
  }

  const now = new Date().toISOString();
  sqliteDb
    .prepare(
      `INSERT INTO users (
        id,
        username,
        password_hash,
        display_name,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run("admin", "admin", hashPassword("admin123"), "Admin", now, now);
}

seedDefaultAdminUser();

export function getUserByUsername(username: string): DbUser | undefined {
  const row = sqliteDb
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as UserRow | undefined;
  return mapUserRow(row);
}

export function getUserById(userId: string): DbUser | undefined {
  const row = sqliteDb
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(userId) as UserRow | undefined;
  return mapUserRow(row);
}
