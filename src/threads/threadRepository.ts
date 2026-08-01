import crypto from "crypto";
import { sqliteDb } from "../db/sqlite";
import { sqliteVectorStore } from "../rag/sqliteVectorStore";
import { ProviderId, ReasoningEffort } from "../types";

export type ThreadMode = "chat" | "work";

export interface ChatThreadRecord {
  threadId: string;
  userId: string;
  providerId: ProviderId;
  modelId: string;
  roleId: string;
  reasoningEffort?: ReasoningEffort;
  mode: ThreadMode;
  workspacePath?: string;
  workspaceName?: string;
  title: string;
  lastMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
}

// 学习点：SQLite 字段是 snake_case，前端/后端 TS 代码更习惯 camelCase。
// 这个函数专门负责把数据库行转成项目里的对象。
function mapThreadRow(
  row:
    | {
        thread_id: string;
        user_id: string;
        provider_id: ProviderId;
        model_id: string;
        role_id: string;
        reasoning_effort: ReasoningEffort | null;
        mode: ThreadMode;
        workspace_path: string | null;
        workspace_name: string | null;
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
    mode: row.mode,
    workspacePath: row.workspace_path ?? undefined,
    workspaceName: row.workspace_name ?? undefined,
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
  mode?: ThreadMode;
  workspacePath?: string;
  workspaceName?: string;
}): ChatThreadRecord {
  // 学习点：新建对话时先创建 thread 记录。
  // 真正的消息、短期记忆、上传文件会在后续发送消息时逐步写入。
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
          mode,
          workspace_path,
          workspace_name,
          title,
          last_message_preview,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      threadId,
      params.userId,
      params.providerId,
      params.modelId,
      params.roleId,
      params.reasoningEffort ?? null,
      params.mode ?? "chat",
      params.workspacePath ?? null,
      params.workspaceName ?? null,
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
    mode: params.mode ?? "chat",
    workspacePath: params.workspacePath,
    workspaceName: params.workspaceName,
    title: "New chat",
    createdAt: now,
    updatedAt: now
  };
}

export function listThreadsByUser(
  userId: string,
  mode: ThreadMode = "chat",
  workspacePath?: string
): ChatThreadRecord[] {
  // 学习点：左侧会话列表按 userId 查询，避免不同用户看到彼此对话。
  const workspaceFilter =
    mode === "work" && workspacePath ? "AND workspace_path = ?" : "";
  const statement = sqliteDb.prepare(
    `
        SELECT
          thread_id,
          user_id,
          provider_id,
          model_id,
          role_id,
          reasoning_effort,
          mode,
          workspace_path,
          workspace_name,
          title,
          last_message_preview,
          created_at,
          updated_at
        FROM chat_threads
        WHERE user_id = ? AND mode = ? ${workspaceFilter}
        ORDER BY updated_at DESC
      `
  );
  const rows = statement.all(
    ...(workspaceFilter ? [userId, mode, workspacePath] : [userId, mode])
  ) as Array<{
    thread_id: string;
    user_id: string;
    provider_id: ProviderId;
    model_id: string;
    role_id: string;
    reasoning_effort: ReasoningEffort | null;
    mode: ThreadMode;
    workspace_path: string | null;
    workspace_name: string | null;
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
  // 学习点：查单个 thread 时同时带 userId，是为了做最基础的用户隔离。
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
          mode,
          workspace_path,
          workspace_name,
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
        mode: ThreadMode;
        workspace_path: string | null;
        workspace_name: string | null;
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
  // 学习点：每次用户发消息后，更新标题预览、模型、角色和更新时间。
  // 如果还是 New chat，就用第一条用户消息自动生成标题。
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
  // 学习点：重命名只改标题，不改对话内容和记忆。
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
  // 学习点：删除对话不是只删 chat_threads。
  // 还要清理文档问答记录、上传文档记录、向量索引和 LangGraph checkpoint。
  const thread = getThreadById(threadId, userId);
  if (!thread) {
    return false;
  }

  const deleteRowsWithThreadId = (tableName: string) => {
    // 学习点：LangGraph 的 checkpoint 表可能由库创建。
    // 删除前先看表里有没有 thread_id 字段，避免误删不相关表。
    const columns = sqliteDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === "thread_id")) {
      return;
    }

    sqliteDb.prepare(`DELETE FROM ${tableName} WHERE thread_id = ?`).run(threadId);
  };

  const deleteTransaction = sqliteDb.transaction(() => {
    sqliteDb.prepare("DELETE FROM workspace_activity WHERE thread_id = ?").run(threadId);
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
