import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const SQLITE_DB_PATH = path.join(dataDir, "chat-demo.sqlite");

// 所有持久化能力共用一个 SQLite 文件。
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
`);

// LangGraph 短期记忆改为 SQLite Checkpointer，项目重启后仍可恢复 thread。
export const sqliteCheckpointer = SqliteSaver.fromConnString(SQLITE_DB_PATH);
