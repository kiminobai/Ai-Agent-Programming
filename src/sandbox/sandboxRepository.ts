import { getDatabaseForThread } from "../db/sqlite";

export type SandboxRecord = {
  threadId: string;
  userId: string;
  provider: string;
  sandboxName: string;
  sandboxId: string | null;
  status: string;
};

export function getSandboxRecord(threadId: string): SandboxRecord | null {
  const row = getDatabaseForThread(threadId)
    .prepare(`SELECT thread_id, user_id, provider, sandbox_name, sandbox_id, status
      FROM thread_sandboxes WHERE thread_id = ?`)
    .get(threadId) as {
      thread_id: string;
      user_id: string;
      provider: string;
      sandbox_name: string;
      sandbox_id: string | null;
      status: string;
    } | undefined;
  return row
    ? {
        threadId: row.thread_id,
        userId: row.user_id,
        provider: row.provider,
        sandboxName: row.sandbox_name,
        sandboxId: row.sandbox_id,
        status: row.status
      }
    : null;
}

export function saveSandboxRecord(input: SandboxRecord): void {
  const now = new Date().toISOString();
  getDatabaseForThread(input.threadId)
    .prepare(`INSERT INTO thread_sandboxes (
      thread_id, user_id, provider, sandbox_name, sandbox_id, status,
      created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      user_id = excluded.user_id,
      provider = excluded.provider,
      sandbox_name = excluded.sandbox_name,
      sandbox_id = excluded.sandbox_id,
      status = excluded.status,
      updated_at = excluded.updated_at,
      last_used_at = excluded.last_used_at`)
    .run(
      input.threadId,
      input.userId,
      input.provider,
      input.sandboxName,
      input.sandboxId,
      input.status,
      now,
      now,
      now
    );
}

export function deleteSandboxRecord(threadId: string): void {
  getDatabaseForThread(threadId)
    .prepare("DELETE FROM thread_sandboxes WHERE thread_id = ?")
    .run(threadId);
}
