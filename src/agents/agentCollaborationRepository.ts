/**
 * Agent 协作持久化层。
 *
 * 私有推理永不写入这里；只保存调度所需的任务状态、结构化消息、结果摘要
 * 和产物引用。Chat/Work 会根据 threadId 自动写入各自的 SQLite。
 */
import { randomUUID } from "node:crypto";
import { getDatabaseForThread } from "../db/sqlite";

export type CollaborationTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "timed_out"
  | "cancelled";

export type AgentMessageType = "request" | "result" | "feedback" | "handoff";

export function createCollaborationPlan(input: {
  threadId: string;
  turnId: string;
  userId: string;
  mode: "consult" | "execute";
  tasks: Array<{
    id: string;
    specialistId: string;
    task: string;
    dependsOn: string[];
    allowedPaths?: string[];
  }>;
}): void {
  const database = getDatabaseForThread(input.threadId);
  const now = new Date().toISOString();
  const insert = database.prepare(`
    INSERT OR REPLACE INTO agent_collaboration_tasks (
      thread_id, turn_id, task_id, user_id, specialist_id, mode,
      task_summary, depends_on_json, allowed_paths_json, status,
      attempt, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)
  `);
  const transaction = database.transaction(() => {
    for (const task of input.tasks) {
      insert.run(
        input.threadId,
        input.turnId,
        task.id,
        input.userId,
        task.specialistId,
        input.mode,
        task.task.slice(0, 500),
        JSON.stringify(task.dependsOn),
        JSON.stringify(task.allowedPaths ?? []),
        now
      );
    }
  });
  transaction();
}

export function updateCollaborationTask(input: {
  threadId: string;
  turnId: string;
  taskId: string;
  status: CollaborationTaskStatus;
  resultSummary?: string;
  errorText?: string;
}): void {
  const database = getDatabaseForThread(input.threadId);
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE agent_collaboration_tasks
    SET status = ?,
        attempt = CASE WHEN ? = 'running' THEN attempt + 1 ELSE attempt END,
        started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
        completed_at = CASE WHEN ? IN ('succeeded','failed','blocked','timed_out','cancelled') THEN ? ELSE completed_at END,
        result_summary = COALESCE(?, result_summary),
        error_text = ?
    WHERE thread_id = ? AND turn_id = ? AND task_id = ?
  `).run(
    input.status,
    input.status,
    input.status,
    now,
    input.status,
    now,
    input.resultSummary?.slice(0, 5_000) ?? null,
    input.errorText?.slice(0, 2_000) ?? null,
    input.threadId,
    input.turnId,
    input.taskId
  );
}

export function appendAgentMessage(input: {
  threadId: string;
  turnId: string;
  taskId: string;
  correlationId: string;
  from: string;
  to: string;
  type: AgentMessageType;
  payload: unknown;
}): void {
  getDatabaseForThread(input.threadId).prepare(`
    INSERT INTO agent_collaboration_messages (
      message_id, thread_id, turn_id, task_id, correlation_id,
      from_agent, to_agent, message_type, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.threadId,
    input.turnId,
    input.taskId,
    input.correlationId,
    input.from,
    input.to,
    input.type,
    JSON.stringify(input.payload),
    new Date().toISOString()
  );
}

export function writeBlackboardResult(input: {
  threadId: string;
  turnId: string;
  taskId: string;
  authorAgent: string;
  content: unknown;
}): void {
  getDatabaseForThread(input.threadId).prepare(`
    INSERT INTO agent_blackboard_entries (
      entry_id, thread_id, turn_id, task_id, author_agent,
      entry_type, content_json, created_at
    ) VALUES (?, ?, ?, ?, ?, 'result', ?, ?)
    ON CONFLICT(thread_id, turn_id, task_id, entry_type)
    DO UPDATE SET content_json = excluded.content_json,
                  author_agent = excluded.author_agent,
                  created_at = excluded.created_at
  `).run(
    randomUUID(),
    input.threadId,
    input.turnId,
    input.taskId,
    input.authorAgent,
    JSON.stringify(input.content),
    new Date().toISOString()
  );
}

export function readBlackboardResults(input: {
  threadId: string;
  turnId: string;
  taskIds: string[];
}): Array<{ taskId: string; authorAgent: string; content: unknown }> {
  if (input.taskIds.length === 0) return [];
  const placeholders = input.taskIds.map(() => "?").join(",");
  const rows = getDatabaseForThread(input.threadId).prepare(`
    SELECT task_id AS taskId, author_agent AS authorAgent, content_json AS contentJson
    FROM agent_blackboard_entries
    WHERE thread_id = ? AND turn_id = ? AND entry_type = 'result'
      AND task_id IN (${placeholders})
    ORDER BY created_at ASC
  `).all(input.threadId, input.turnId, ...input.taskIds) as Array<{
    taskId: string;
    authorAgent: string;
    contentJson: string;
  }>;
  return rows.map((row) => ({
    taskId: row.taskId,
    authorAgent: row.authorAgent,
    content: JSON.parse(row.contentJson) as unknown
  }));
}
