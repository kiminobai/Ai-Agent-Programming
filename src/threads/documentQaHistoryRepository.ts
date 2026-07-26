import crypto from "crypto";
import { sqliteDb } from "../db/sqlite";

export interface DocumentQaHistoryMessage {
  messageId: string;
  threadId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  attachmentName?: string;
  attachmentFileId?: string;
  sources?: unknown[];
  createdAt: string;
}

// 学习点：文档问答走的是单独历史表。
// 这样刷新页面后，用户能看到“问题 + 附件卡片 + AI 回答”。
type DocumentQaHistoryRow = {
  message_id: string;
  thread_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  attachment_name: string | null;
  attachment_file_id: string | null;
  sources_json: string | null;
  created_at: string;
};

export function saveDocumentQaExchange(input: {
  threadId: string;
  userId: string;
  question: string;
  answer: string;
  attachmentName?: string;
  attachmentFileId?: string;
  sources?: unknown[];
}): void {
  // 学习点：一次文档问答会保存两条消息：用户问题和助手回答。
  // 附件信息挂在用户消息上，sources 只保存给后端需要时使用。
  const now = new Date().toISOString();
  const insert = sqliteDb.prepare(
    `
      INSERT INTO document_qa_messages (
        message_id,
        thread_id,
        user_id,
        role,
        content,
        attachment_name,
        attachment_file_id,
        sources_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  const saveExchange = sqliteDb.transaction(() => {
    insert.run(
      crypto.randomUUID(),
      input.threadId,
      input.userId,
      "user",
      input.question,
      input.attachmentName ?? null,
      input.attachmentFileId ?? null,
      null,
      now
    );
    insert.run(
      crypto.randomUUID(),
      input.threadId,
      input.userId,
      "assistant",
      input.answer,
      null,
      null,
      JSON.stringify(input.sources ?? []),
      new Date(Date.parse(now) + 1).toISOString()
    );
  });

  saveExchange();
}

export function listDocumentQaMessages(
  threadId: string,
  userId: string
): DocumentQaHistoryMessage[] {
  // 学习点：恢复对话时按 threadId + userId 查询，保证不同用户隔离。
  const rows = sqliteDb
    .prepare(
      `
        SELECT
          message_id,
          thread_id,
          user_id,
          role,
          content,
          attachment_name,
          attachment_file_id,
          sources_json,
          created_at
        FROM document_qa_messages
        WHERE thread_id = ? AND user_id = ?
        ORDER BY created_at ASC
      `
    )
    .all(threadId, userId) as DocumentQaHistoryRow[];

  return rows.map((row) => ({
    messageId: row.message_id,
    threadId: row.thread_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    attachmentName: row.attachment_name ?? undefined,
    attachmentFileId: row.attachment_file_id ?? undefined,
    sources: row.sources_json ? JSON.parse(row.sources_json) : undefined,
    createdAt: row.created_at
  }));
}
