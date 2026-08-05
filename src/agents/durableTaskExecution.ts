/**
 * Agent 副作用与高成本任务的 Durable Execution 账本。
 *
 * LangGraph Checkpointer 保存“流程走到哪里”；本表保存“某个操作是否已经执行”。
 * 两者组合后，恢复或重试可以复用成功结果，而不是再次写文件、运行命令或调用模型。
 */
import crypto from "crypto";
import { getDatabaseForThread } from "../db/sqlite";
import type { AgentContext } from "./agentContext";
import type { ToolMemoryRuntime } from "./toolMemoryState";

type ExecutionStatus = "running" | "succeeded" | "failed";

type ExecutionRow = {
  idempotency_key: string;
  input_hash: string;
  status: ExecutionStatus;
  result_json: string | null;
  error_text: string | null;
};

export type DurableExecutionInfo = {
  idempotencyKey: string;
  replayed: boolean;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalize(nestedValue)])
  );
}

function hashValue(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function buildIdempotencyKey(
  runtime: ToolMemoryRuntime,
  operationName: string,
  inputHash: string
): {
  key: string;
  context: AgentContext;
} {
  const context = (runtime.context ?? {}) as AgentContext;
  if (!context.userId || !context.threadId) {
    throw new Error("Durable task 缺少 userId 或 threadId。");
  }

  // toolCall.id 在 LangGraph 恢复同一次工具调用时保持稳定。
  // 极端情况下没有 toolCall.id，则退回 turnId + 输入哈希，仍能阻止同轮重复执行。
  const callIdentity =
    runtime.toolCall?.id?.trim() ||
    `${context.turnId ?? "no-turn"}:${inputHash}`;
  const key = crypto
    .createHash("sha256")
    .update(
      [
        context.userId,
        context.threadId,
        context.turnId ?? "",
        operationName,
        callIdentity
      ].join("\u0000")
    )
    .digest("hex");

  return { key, context };
}

export async function executeDurableTask<T>(
  runtime: ToolMemoryRuntime,
  operationName: string,
  input: unknown,
  execute: (info: DurableExecutionInfo) => Promise<T> | T
): Promise<{
  result: T;
  idempotencyKey: string;
  replayed: boolean;
}> {
  runtime.signal?.throwIfAborted();
  const inputHash = hashValue(input);
  const { key, context } = buildIdempotencyKey(
    runtime,
    operationName,
    inputHash
  );
  const database = getDatabaseForThread(context.threadId);

  const readExecution = () =>
    database
    .prepare(
      `SELECT idempotency_key, input_hash, status, result_json, error_text
       FROM agent_task_executions
       WHERE idempotency_key = ?`
    )
    .get(key) as ExecutionRow | undefined;

  const reuseExisting = (existing: ExecutionRow): {
    result: T;
    idempotencyKey: string;
    replayed: boolean;
  } => {
    if (existing.input_hash !== inputHash) {
      throw new Error("检测到幂等键冲突，已阻止执行。");
    }
    if (existing.status === "succeeded" && existing.result_json) {
      return {
        result: JSON.parse(existing.result_json) as T,
        idempotencyKey: key,
        replayed: true
      };
    }
    if (existing.status === "running") {
      throw new Error(
        "该操作此前可能已开始执行。为避免重复副作用，系统不会自动重跑，请确认实际结果后重新发起任务。"
      );
    }

    throw new Error(existing.error_text || "该操作此前执行失败，未自动重试。");
  };

  const existing = readExecution();
  if (existing) {
    return reuseExisting(existing);
  }

  const now = new Date().toISOString();
  const claim = database
    .prepare(
      `INSERT OR IGNORE INTO agent_task_executions (
        idempotency_key, thread_id, user_id, turn_id, operation_name,
        input_hash, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(
      key,
      context.threadId,
      context.userId,
      context.turnId ?? null,
      operationName,
      inputHash,
      now
    );

  // 两个并行请求可能同时看到“尚无记录”；只有成功 INSERT 的请求可以执行。
  // 另一个请求读取获胜者状态，不会重复触发副作用。
  if (claim.changes === 0) {
    const claimedByAnotherRequest = readExecution();
    if (!claimedByAnotherRequest) {
      throw new Error("任务幂等状态读取失败，请稍后重试。");
    }
    return reuseExisting(claimedByAnotherRequest);
  }

  try {
    const result = await execute({ idempotencyKey: key, replayed: false });
    runtime.signal?.throwIfAborted();
    database
      .prepare(
        `UPDATE agent_task_executions
         SET status = 'succeeded', result_json = ?, completed_at = ?
         WHERE idempotency_key = ?`
      )
      .run(JSON.stringify(result), new Date().toISOString(), key);
    return { result, idempotencyKey: key, replayed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    database
      .prepare(
        `UPDATE agent_task_executions
         SET status = 'failed', error_text = ?, completed_at = ?
         WHERE idempotency_key = ?`
      )
      .run(message, new Date().toISOString(), key);
    throw error;
  }
}
