import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { hashPassword } from "../auth";
import { WORK_SQLITE_DB_PATH } from "../workspace/localWorkStorage";

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

  -- Work 每轮修改前的独立文件快照。它不使用 .git，因此不会污染用户仓库。
  CREATE TABLE IF NOT EXISTS workspace_turn_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    snapshot_key TEXT,
    existed_before INTEGER NOT NULL,
    before_hash TEXT,
    after_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    rolled_back_at TEXT,
    UNIQUE(thread_id, turn_id, file_path)
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_turn_snapshots_thread_turn
  ON workspace_turn_snapshots(thread_id, turn_id, created_at ASC);

  -- Work 文件冲突记录。用于区分 Agent 读取后的外部改动与回退阶段的二次改动。
  CREATE TABLE IF NOT EXISTS workspace_turn_conflicts (
    conflict_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    expected_hash TEXT,
    actual_hash TEXT,
    status TEXT NOT NULL DEFAULT 'unresolved',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_turn_conflicts_thread_turn
  ON workspace_turn_conflicts(thread_id, turn_id, status, created_at ASC);

  -- Durable task ledger. A stable idempotency key prevents retries or resumes
  -- from executing the same side effect or expensive sub-agent task twice.
  CREATE TABLE IF NOT EXISTS agent_task_executions (
    idempotency_key TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    turn_id TEXT,
    operation_name TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    error_text TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_task_thread_started
  ON agent_task_executions(thread_id, started_at ASC);

  -- Supervisor/Subagent task tree. The UI restores this hierarchy after refresh.
  -- Only task metadata and status are stored; private subagent analysis is not exposed.
  CREATE TABLE IF NOT EXISTS subagent_runs (
    run_id TEXT PRIMARY KEY,
    parent_run_id TEXT,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    turn_id TEXT,
    role_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_label TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    depth INTEGER NOT NULL,
    status TEXT NOT NULL,
    tool_names_json TEXT NOT NULL DEFAULT '[]',
    replayed INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_text TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_subagent_runs_thread_turn
  ON subagent_runs(thread_id, turn_id, started_at ASC);

  -- Agent 协作任务 DAG。与对话消息分离，保存依赖、状态、预算和结构化结果。
  CREATE TABLE IF NOT EXISTS agent_collaboration_tasks (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    specialist_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    allowed_paths_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    PRIMARY KEY (thread_id, turn_id, task_id)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_collaboration_tasks_turn
  ON agent_collaboration_tasks(thread_id, turn_id, status, created_at ASC);

  -- Agent 间只交换结构化消息，不共享私有 Prompt、思考过程或完整历史。
  CREATE TABLE IF NOT EXISTS agent_collaboration_messages (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    message_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_collaboration_messages_turn
  ON agent_collaboration_messages(thread_id, turn_id, created_at ASC);

  -- Blackboard 保存可被依赖任务读取的确认结果和产物引用。
  CREATE TABLE IF NOT EXISTS agent_blackboard_entries (
    entry_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    author_agent TEXT NOT NULL,
    entry_type TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(thread_id, turn_id, task_id, entry_type)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_blackboard_turn
  ON agent_blackboard_entries(thread_id, turn_id, created_at ASC);

  -- 每个子任务的预算与实际消耗。字符数同时换算为近似 Token，避免依赖特定模型字段。
  CREATE TABLE IF NOT EXISTS agent_task_metrics (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    input_chars INTEGER NOT NULL DEFAULT 0,
    output_chars INTEGER NOT NULL DEFAULT 0,
    estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id, task_id)
  );

  -- 结构化可观测事件。只记录阶段、耗时和状态，不记录私有推理。
  CREATE TABLE IF NOT EXISTS agent_observability_events (
    event_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    turn_id TEXT,
    task_id TEXT,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_observability_turn
  ON agent_observability_events(thread_id, turn_id, created_at ASC);

  -- 模型请求预算账本：失败请求也保留，因为供应商会把失败的限流请求计入 RPM/TPM。
  CREATE TABLE IF NOT EXISTS model_usage_events (
    event_id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    pricing_configured INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_model_usage_rate_window
  ON model_usage_events(provider_id, model_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_model_usage_user_day
  ON model_usage_events(user_id, created_at);

  -- Work Agent 的结构化任务计划。计划与聊天文本分离，刷新后仍能恢复。
  CREATE TABLE IF NOT EXISTS agent_task_plans (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );

  CREATE TABLE IF NOT EXISTS agent_task_plan_steps (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id, step_id),
    FOREIGN KEY (thread_id, turn_id)
      REFERENCES agent_task_plans(thread_id, turn_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agent_task_plans_thread_updated
  ON agent_task_plans(thread_id, updated_at ASC);

  -- Chat 模式由 Agent 生成、供用户下载的文件。文件本体保存在 data/generated。
  CREATE TABLE IF NOT EXISTS generated_files (
    file_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    turn_id TEXT,
    source_file_id TEXT,
    parent_file_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    edit_mode TEXT NOT NULL DEFAULT 'generated',
    file_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_generated_files_thread_turn
  ON generated_files(thread_id, turn_id, created_at ASC);

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
    metadata_json TEXT NOT NULL DEFAULT '{}',
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
  ["deletions", "INTEGER"],
  ["idempotency_key", "TEXT"]
] as const) {
  addColumnIfMissing("workspace_activity", columnName, definition);
}

sqliteDb.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_activity_idempotency
  ON workspace_activity(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`);

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
  ["index_status", "TEXT"],
  ["loader_documents_json", "TEXT"]
] as const) {
  addColumnIfMissing("uploaded_documents", columnName, definition);
}

for (const [columnName, definition] of [
  ["source_type", "TEXT NOT NULL DEFAULT 'text'"],
  ["page_number", "INTEGER"],
  ["block_index", "INTEGER NOT NULL DEFAULT 0"],
  ["locator", "TEXT NOT NULL DEFAULT ''"],
  ["metadata_json", "TEXT NOT NULL DEFAULT '{}'"]
] as const) {
  // 学习点：这些字段保存 chunk 的位置和结构元数据。
  // 页码、原始块、表格/图片类型及切分策略都依赖它们在重启后恢复。
  addColumnIfMissing("document_chunks", columnName, definition);
}

for (const [columnName, definition] of [
  ["source_file_id", "TEXT"],
  ["parent_file_id", "TEXT"],
  ["version", "INTEGER NOT NULL DEFAULT 1"],
  ["edit_mode", "TEXT NOT NULL DEFAULT 'generated'"]
] as const) {
  // 修改版文件必须保留来源和版本，重启后才不会把它误当成全新文件。
  addColumnIfMissing("generated_files", columnName, definition);
}

sqliteDb.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_documents_file_id
  ON uploaded_documents(file_id)
  WHERE file_id IS NOT NULL;
`);

function createEmptyWorkDatabase(): Database.Database {
  const database = new Database(WORK_SQLITE_DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  // 主库迁移完成后，从 sqlite_master 复制“空表结构”，不复制任何 Chat 数据。
  // 这样 Work 与 Chat 使用相同 Schema，但落在两个完全独立的文件中。
  const schemaRows = sqliteDb
    .prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE sql IS NOT NULL
        AND type IN ('table', 'index')
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name
    `)
    .all() as Array<{ type: "table" | "index"; name: string; sql: string }>;

  for (const row of schemaRows) {
    if (
      row.name.startsWith("sqlite_") ||
      /^document_chunks_fts_(data|idx|content|docsize|config)$/.test(row.name)
    ) {
      continue;
    }

    // LangGraph 等第三方库创建的表，其 sqlite_master SQL 不一定带
    // IF NOT EXISTS。Work 数据库第二次启动时必须先检查对象是否已存在，
    // 否则会因重复创建 agent_control_messages 等表而启动失败。
    const alreadyExists = database
      .prepare(
        `SELECT 1
         FROM sqlite_master
         WHERE type = ? AND name = ?`
      )
      .get(row.type, row.name);
    if (alreadyExists) {
      continue;
    }

    database.exec(row.sql);
  }
  return database;
}

export const workSqliteDb = createEmptyWorkDatabase();

for (const [columnName, definition] of [
  ["source_file_id", "TEXT"],
  ["parent_file_id", "TEXT"],
  ["version", "INTEGER NOT NULL DEFAULT 1"],
  ["edit_mode", "TEXT NOT NULL DEFAULT 'generated'"]
] as const) {
  const rows = workSqliteDb
    .prepare("PRAGMA table_info(generated_files)")
    .all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === columnName)) {
    // 已存在的 Work 数据库不会重新复制主库 Schema，因此需要单独迁移。
    workSqliteDb.exec(
      `ALTER TABLE generated_files ADD COLUMN ${columnName} ${definition}`
    );
  }
}

export function getDatabaseForThread(threadId: string): Database.Database {
  const isWorkThread = workSqliteDb
    .prepare("SELECT 1 FROM chat_threads WHERE thread_id = ?")
    .get(threadId);
  return isWorkThread ? workSqliteDb : sqliteDb;
}

// LangGraph 短期记忆使用 SQLite Checkpointer，项目重启后仍可恢复 thread state。
export const sqliteCheckpointer = SqliteSaver.fromConnString(SQLITE_DB_PATH);
export const workSqliteCheckpointer =
  SqliteSaver.fromConnString(WORK_SQLITE_DB_PATH);

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
