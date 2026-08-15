/**
 * AI 团队任务的预算与可观测性仓储。
 *
 * 这里只保存可审计的运行事实，不保存模型隐藏推理、System Prompt 或完整上下文。
 */
import { randomUUID } from "node:crypto";
import { getDatabaseForThread } from "../db/sqlite";
import { recordCompletedSpan } from "../observability/telemetry";

export function estimateTokensFromChars(chars: number): number {
  // 中英文混合文本无法在不绑定模型 tokenizer 的情况下精确计算，4 字符约 1 Token 用于预算预警。
  return Math.max(0, Math.ceil(chars / 4));
}

export function saveAgentTaskMetrics(input: {
  threadId: string;
  turnId: string;
  taskId: string;
  inputChars: number;
  outputChars: number;
  attempts: number;
  elapsedMs: number;
  status: string;
}): void {
  getDatabaseForThread(input.threadId).prepare(`
    INSERT INTO agent_task_metrics (
      thread_id, turn_id, task_id, input_chars, output_chars,
      estimated_input_tokens, estimated_output_tokens, attempts,
      elapsed_ms, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id, turn_id, task_id) DO UPDATE SET
      input_chars = excluded.input_chars,
      output_chars = excluded.output_chars,
      estimated_input_tokens = excluded.estimated_input_tokens,
      estimated_output_tokens = excluded.estimated_output_tokens,
      attempts = excluded.attempts,
      elapsed_ms = excluded.elapsed_ms,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    input.threadId,
    input.turnId,
    input.taskId,
    input.inputChars,
    input.outputChars,
    estimateTokensFromChars(input.inputChars),
    estimateTokensFromChars(input.outputChars),
    input.attempts,
    input.elapsedMs,
    input.status,
    new Date().toISOString()
  );
}

export function recordAgentEvent(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  taskId?: string;
  eventType: string;
  status: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}): void {
  getDatabaseForThread(input.threadId).prepare(`
    INSERT INTO agent_observability_events (
      event_id, thread_id, user_id, turn_id, task_id, event_type,
      status, duration_ms, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.threadId,
    input.userId,
    input.turnId ?? null,
    input.taskId ?? null,
    input.eventType,
    input.status,
    input.durationMs ?? null,
    JSON.stringify(input.metadata ?? {}),
    new Date().toISOString()
  );
  recordCompletedSpan({
    name: `agent.${input.eventType}`,
    status: input.status,
    durationMs: input.durationMs,
    attributes: {
      "kimibai.user.id": input.userId,
      "kimibai.thread.id": input.threadId,
      "kimibai.turn.id": input.turnId || "",
      "kimibai.task.id": input.taskId || "",
      "kimibai.event.type": input.eventType
    }
  });
}

export function getAgentTurnObservability(
  threadId: string,
  userId: string,
  turnId: string
) {
  const database = getDatabaseForThread(threadId);
  const metrics = database.prepare(`
    SELECT
      task_id AS taskId, input_chars AS inputChars, output_chars AS outputChars,
      estimated_input_tokens AS estimatedInputTokens,
      estimated_output_tokens AS estimatedOutputTokens, attempts,
      elapsed_ms AS elapsedMs, status
    FROM agent_task_metrics
    WHERE thread_id = ? AND turn_id = ?
    ORDER BY task_id ASC
  `).all(threadId, turnId);
  const events = database.prepare(`
    SELECT
      event_id AS eventId, task_id AS taskId, event_type AS eventType,
      status, duration_ms AS durationMs, metadata_json AS metadataJson,
      created_at AS createdAt
    FROM agent_observability_events
    WHERE thread_id = ? AND user_id = ? AND turn_id = ?
    ORDER BY created_at ASC
  `).all(threadId, userId, turnId) as Array<Record<string, unknown> & { metadataJson: string }>;
  return {
    metrics,
    events: events.map(({ metadataJson, ...event }) => ({
      ...event,
      metadata: JSON.parse(metadataJson)
    }))
  };
}
