import { randomUUID } from "node:crypto";
import { getDatabaseForThread, sqliteDb, workSqliteDb } from "../db/sqlite";

export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackgroundTask<TPayload = unknown> {
  taskId: string;
  threadId: string;
  turnId: string;
  userId: string;
  taskType: string;
  title: string;
  payload: TPayload;
  status: BackgroundTaskStatus;
  progress: number;
  stage: string;
  statusMessage: string;
  attempt: number;
  maxAttempts: number;
  cancelRequested: boolean;
  errorText?: string;
  result?: unknown;
  availableAt: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

type TaskRow = {
  taskId: string;
  threadId: string;
  turnId: string;
  userId: string;
  taskType: string;
  title: string;
  payloadJson: string;
  status: BackgroundTaskStatus;
  progress: number;
  stage: string;
  statusMessage: string;
  attempt: number;
  maxAttempts: number;
  cancelRequested: number;
  errorText?: string;
  resultJson?: string;
  availableAt: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

const SELECT_TASK = `SELECT task_id AS taskId, thread_id AS threadId,
  turn_id AS turnId, user_id AS userId, task_type AS taskType, title,
  payload_json AS payloadJson, status, progress, stage,
  status_message AS statusMessage, attempt, max_attempts AS maxAttempts,
  cancel_requested AS cancelRequested, error_text AS errorText,
  result_json AS resultJson, available_at AS availableAt,
  created_at AS createdAt, started_at AS startedAt,
  completed_at AS completedAt, updated_at AS updatedAt
  FROM background_tasks`;

function mapTask<TPayload>(row: TaskRow): BackgroundTask<TPayload> {
  return {
    ...row,
    payload: JSON.parse(row.payloadJson) as TPayload,
    result: row.resultJson ? JSON.parse(row.resultJson) : undefined,
    cancelRequested: Boolean(row.cancelRequested),
    errorText: row.errorText || undefined,
    startedAt: row.startedAt || undefined,
    completedAt: row.completedAt || undefined
  };
}

export function enqueueBackgroundTask<TPayload>(input: {
  threadId: string;
  turnId: string;
  userId: string;
  taskType: string;
  title: string;
  payload: TPayload;
  maxAttempts?: number;
}): BackgroundTask<TPayload> {
  const database = getDatabaseForThread(input.threadId);
  const now = new Date().toISOString();
  const taskId = randomUUID();
  database.prepare(`INSERT INTO background_tasks (
    task_id, thread_id, turn_id, user_id, task_type, title, payload_json,
    status, progress, stage, status_message, max_attempts, available_at,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 'queued', '等待处理', ?, ?, ?, ?)`)
    .run(taskId, input.threadId, input.turnId, input.userId, input.taskType,
      input.title, JSON.stringify(input.payload), input.maxAttempts ?? 5, now, now, now);
  appendBackgroundTaskEvent(taskId, input.threadId, "task", {
    type: "task",
    task: { taskId, turnId: input.turnId, status: "queued", progress: 0,
      stage: "queued", statusMessage: "等待处理", title: input.title }
  });
  return getBackgroundTask<TPayload>(taskId, input.threadId)!;
}

export function getBackgroundTask<TPayload = unknown>(
  taskId: string,
  threadId: string
): BackgroundTask<TPayload> | undefined {
  const row = getDatabaseForThread(threadId)
    .prepare(`${SELECT_TASK} WHERE task_id = ? AND thread_id = ?`)
    .get(taskId, threadId) as TaskRow | undefined;
  return row ? mapTask<TPayload>(row) : undefined;
}

export function listBackgroundTasks(threadId: string, userId: string): BackgroundTask[] {
  return (getDatabaseForThread(threadId)
    .prepare(`${SELECT_TASK} WHERE thread_id = ? AND user_id = ? ORDER BY created_at ASC`)
    .all(threadId, userId) as TaskRow[]).map(mapTask);
}

export function claimNextBackgroundTask(): BackgroundTask | undefined {
  for (const database of [sqliteDb, workSqliteDb]) {
    const now = new Date().toISOString();
    const claimed = database.transaction(() => {
      const row = database.prepare(
        `${SELECT_TASK} WHERE status IN ('queued', 'retrying') AND available_at <= ?
         ORDER BY created_at ASC LIMIT 1`
      ).get(now) as TaskRow | undefined;
      if (!row) return undefined;
      const changed = database.prepare(`UPDATE background_tasks SET
        status = 'running', stage = 'starting', status_message = '正在启动任务',
        attempt = attempt + 1, started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE task_id = ? AND status IN ('queued', 'retrying')`)
        .run(now, now, row.taskId);
      return changed.changes ? row.taskId : undefined;
    })();
    if (claimed) {
      const row = database.prepare(`${SELECT_TASK} WHERE task_id = ?`).get(claimed) as TaskRow;
      return mapTask(row);
    }
  }
  return undefined;
}

export function updateBackgroundTask(input: {
  taskId: string;
  threadId: string;
  status?: BackgroundTaskStatus;
  progress?: number;
  stage?: string;
  statusMessage?: string;
  errorText?: string | null;
  result?: unknown;
  availableAt?: string;
  attempt?: number;
  startedAt?: string;
}): void {
  const task = getBackgroundTask(input.taskId, input.threadId);
  if (!task) return;
  const status = input.status ?? task.status;
  const completed = ["completed", "failed", "cancelled"].includes(status);
  getDatabaseForThread(input.threadId).prepare(`UPDATE background_tasks SET
    status = ?, progress = ?, stage = ?, status_message = ?, error_text = ?,
    result_json = ?, available_at = ?, attempt = ?, started_at = ?,
    completed_at = ?, updated_at = ?
    WHERE task_id = ?`)
    .run(status, input.progress ?? task.progress, input.stage ?? task.stage,
      input.statusMessage ?? task.statusMessage,
      input.errorText === undefined ? task.errorText ?? null : input.errorText,
      input.result === undefined ? (task.result ? JSON.stringify(task.result) : null) : JSON.stringify(input.result),
      input.availableAt ?? task.availableAt, input.attempt ?? task.attempt,
      input.startedAt ?? task.startedAt ?? null, completed ? new Date().toISOString() : null,
      new Date().toISOString(), input.taskId);
}

export function requestBackgroundTaskCancellation(taskId: string, threadId: string): boolean {
  const database = getDatabaseForThread(threadId);
  const now = new Date().toISOString();
  const changed = database.transaction(() => {
    const pending = database.prepare(`UPDATE background_tasks SET cancel_requested = 1,
      status = 'cancelled', stage = 'cancelled', status_message = '已停止',
      completed_at = ?, updated_at = ?
      WHERE task_id = ? AND status IN ('queued', 'retrying')`)
      .run(now, now, taskId);
    const running = database.prepare(`UPDATE background_tasks SET cancel_requested = 1,
      status_message = '正在停止', updated_at = ?
      WHERE task_id = ? AND status = 'running'`)
      .run(now, taskId);
    return pending.changes + running.changes;
  })();
  if (changed > 0) {
    const task = getBackgroundTask(taskId, threadId);
    if (task?.status === "cancelled") {
      appendBackgroundTaskEvent(taskId, threadId, "task", {
        type: "task",
        task: { taskId, turnId: task.turnId, status: "cancelled", progress: task.progress,
          stage: "cancelled", statusMessage: "已停止", title: task.title }
      });
    }
  }
  return changed > 0;
}

export function retryBackgroundTask(taskId: string, threadId: string): boolean {
  const now = new Date().toISOString();
  const changed = getDatabaseForThread(threadId).prepare(`UPDATE background_tasks SET
    status = 'queued', progress = 0, stage = 'queued', status_message = '等待处理',
    cancel_requested = 0, error_text = NULL, completed_at = NULL,
    available_at = ?, updated_at = ? WHERE task_id = ? AND status = 'failed'`)
    .run(now, now, taskId);
  return changed.changes > 0;
}

export function recoverInterruptedBackgroundTasks(): void {
  for (const database of [sqliteDb, workSqliteDb]) {
    database.prepare(`UPDATE background_tasks SET status = 'queued', stage = 'queued',
      status_message = '服务恢复后重新排队', available_at = ?, updated_at = ?
      WHERE status = 'running'`).run(new Date().toISOString(), new Date().toISOString());
  }
}

export function appendBackgroundTaskEvent(
  taskId: string,
  threadId: string,
  eventType: string,
  event: unknown
): number {
  const result = getDatabaseForThread(threadId).prepare(`INSERT INTO background_task_events
    (task_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?)`)
    .run(taskId, eventType, JSON.stringify(event), new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function listBackgroundTaskEvents(taskId: string, threadId: string, after = 0) {
  return getDatabaseForThread(threadId).prepare(`SELECT event_id AS eventId,
    event_type AS eventType, event_json AS eventJson, created_at AS createdAt
    FROM background_task_events WHERE task_id = ? AND event_id > ? ORDER BY event_id ASC`)
    .all(taskId, after) as Array<{ eventId: number; eventType: string; eventJson: string; createdAt: string }>;
}
