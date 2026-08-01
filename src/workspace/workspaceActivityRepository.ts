import { randomUUID } from "crypto";
import { sqliteDb } from "../db/sqlite";

export type WorkspaceActivity = {
  activityId: string;
  threadId: string;
  userId: string;
  turnId?: string;
  activityType: "file_write" | "command";
  filePath?: string;
  additions?: number;
  deletions?: number;
  commandText?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  createdAt: string;
};

export function saveWorkspaceActivity(
  activity: Omit<WorkspaceActivity, "activityId" | "createdAt">
): WorkspaceActivity {
  const record: WorkspaceActivity = {
    ...activity,
    activityId: randomUUID(),
    createdAt: new Date().toISOString()
  };
  sqliteDb.prepare(`
    INSERT INTO workspace_activity (
      activity_id, thread_id, user_id, turn_id, activity_type, file_path, additions, deletions,
      command_text, exit_code, stdout, stderr, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.activityId,
    record.threadId,
    record.userId,
    record.turnId ?? null,
    record.activityType,
    record.filePath ?? null,
    record.additions ?? null,
    record.deletions ?? null,
    record.commandText ?? null,
    record.exitCode ?? null,
    record.stdout ?? null,
    record.stderr ?? null,
    record.createdAt
  );
  return record;
}

export function listWorkspaceActivity(
  threadId: string,
  userId: string
): WorkspaceActivity[] {
  const rows = sqliteDb.prepare(`
    SELECT
      activity_id AS activityId,
      thread_id AS threadId,
      user_id AS userId,
      turn_id AS turnId,
      activity_type AS activityType,
      file_path AS filePath,
      additions,
      deletions,
      command_text AS commandText,
      exit_code AS exitCode,
      stdout,
      stderr,
      created_at AS createdAt
    FROM workspace_activity
    WHERE thread_id = ? AND user_id = ?
    ORDER BY created_at ASC
  `).all(threadId, userId);
  return rows as WorkspaceActivity[];
}
