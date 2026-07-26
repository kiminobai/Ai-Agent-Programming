import crypto from "crypto";
import { sqliteDb } from "../db/sqlite";
import { sqliteVectorStore } from "../rag/sqliteVectorStore";
import { ProviderId, ReasoningEffort } from "../types";

export interface ChatThreadRecord {
  threadId: string;
  userId: string;
  providerId: ProviderId;
  modelId: string;
  roleId: string;
  reasoningEffort?: ReasoningEffort;
  title: string;
  lastMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
}

function mapThreadRow(
  row:
    | {
        thread_id: string;
        user_id: string;
        provider_id: ProviderId;
        model_id: string;
        role_id: string;
        reasoning_effort: ReasoningEffort | null;
        title: string;
        last_message_preview: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined
): ChatThreadRecord | null {
  if (!row) {
    return null;
  }

  return {
    threadId: row.thread_id,
    userId: row.user_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    roleId: row.role_id,
    reasoningEffort: row.reasoning_effort ?? undefined,
    title: row.title,
    lastMessagePreview: row.last_message_preview ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createThread(params: {
  userId: string;
  providerId: ProviderId;
  modelId: string;
  roleId: string;
  reasoningEffort?: ReasoningEffort;
}): ChatThreadRecord {
  const now = new Date().toISOString();
  const threadId = crypto.randomUUID();

  sqliteDb
    .prepare(
      `
        INSERT INTO chat_threads (
          thread_id,
          user_id,
          provider_id,
          model_id,
          role_id,
          reasoning_effort,
          title,
          last_message_preview,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      threadId,
      params.userId,
      params.providerId,
      params.modelId,
      params.roleId,
      params.reasoningEffort ?? null,
      "New chat",
      null,
      now,
      now
    );

  return {
    threadId,
    userId: params.userId,
    providerId: params.providerId,
    modelId: params.modelId,
    roleId: params.roleId,
    reasoningEffort: params.reasoningEffort,
    title: "New chat",
    createdAt: now,
    updatedAt: now
  };
}

export function listThreadsByUser(userId: string): ChatThreadRecord[] {
  const rows = sqliteDb
    .prepare(
      `
        SELECT
          thread_id,
          user_id,
          provider_id,
          model_id,
          role_id,
          reasoning_effort,
          title,
          last_message_preview,
          created_at,
          updated_at
        FROM chat_threads
        WHERE user_id = ?
        ORDER BY updated_at DESC
      `
    )
    .all(userId) as Array<{
    thread_id: string;
    user_id: string;
    provider_id: ProviderId;
    model_id: string;
    role_id: string;
    reasoning_effort: ReasoningEffort | null;
    title: string;
    last_message_preview: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows
    .map((row) => mapThreadRow(row))
    .filter((row): row is ChatThreadRecord => Boolean(row));
}

export function getThreadById(
  threadId: string,
  userId: string
): ChatThreadRecord | null {
  const row = sqliteDb
    .prepare(
      `
        SELECT
          thread_id,
          user_id,
          provider_id,
          model_id,
          role_id,
          reasoning_effort,
          title,
          last_message_preview,
          created_at,
          updated_at
        FROM chat_threads
        WHERE thread_id = ? AND user_id = ?
      `
    )
    .get(threadId, userId) as
    | {
        thread_id: string;
        user_id: string;
        provider_id: ProviderId;
        model_id: string;
        role_id: string;
        reasoning_effort: ReasoningEffort | null;
        title: string;
        last_message_preview: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  return mapThreadRow(row);
}

export function updateThreadAfterMessage(params: {
  threadId: string;
  userId: string;
  providerId: ProviderId;
  modelId: string;
  roleId: string;
  reasoningEffort?: ReasoningEffort;
  userMessage: string;
}): void {
  const now = new Date().toISOString();
  const preview = params.userMessage.trim().slice(0, 120);

  sqliteDb
    .prepare(
      `
        UPDATE chat_threads
        SET
          provider_id = ?,
          model_id = ?,
          role_id = ?,
          reasoning_effort = ?,
          title = CASE
            WHEN title = 'New chat' THEN ?
            ELSE title
          END,
          last_message_preview = ?,
          updated_at = ?
        WHERE thread_id = ? AND user_id = ?
      `
    )
    .run(
      params.providerId,
      params.modelId,
      params.roleId,
      params.reasoningEffort ?? null,
      preview || "New chat",
      preview || null,
      now,
      params.threadId,
      params.userId
    );
}

export function renameThread(
  threadId: string,
  userId: string,
  title: string
): ChatThreadRecord | null {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return null;
  }

  sqliteDb
    .prepare(
      `
        UPDATE chat_threads
        SET
          title = ?,
          updated_at = ?
        WHERE thread_id = ? AND user_id = ?
      `
    )
    .run(trimmedTitle, new Date().toISOString(), threadId, userId);

  return getThreadById(threadId, userId);
}

export function deleteThread(threadId: string, userId: string): boolean {
  const thread = getThreadById(threadId, userId);
  if (!thread) {
    return false;
  }

  const deleteRowsWithThreadId = (tableName: string) => {
    const columns = sqliteDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === "thread_id")) {
      return;
    }

    sqliteDb.prepare(`DELETE FROM ${tableName} WHERE thread_id = ?`).run(threadId);
  };

  const deleteTransaction = sqliteDb.transaction(() => {
    sqliteDb.prepare("DELETE FROM document_qa_messages WHERE thread_id = ?").run(threadId);
    sqliteVectorStore.clearIndex(threadId);
    sqliteDb.prepare("DELETE FROM uploaded_documents WHERE thread_id = ?").run(threadId);

    for (const tableName of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
      const exists = sqliteDb
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = ?
          `
        )
        .get(tableName);

      if (exists) {
        deleteRowsWithThreadId(tableName);
      }
    }

    sqliteDb
      .prepare("DELETE FROM chat_threads WHERE thread_id = ? AND user_id = ?")
      .run(threadId, userId);
  });

  deleteTransaction();
  return true;
}
