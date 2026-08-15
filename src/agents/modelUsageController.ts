/**
 * 模型请求的本地限流与成本控制器。
 *
 * 供应商仍然拥有最终限额；本控制器在请求发出前削平并发、限制 RPM/TPM，
 * 并用 SQLite 账本阻止单用户意外消耗过多 Token。
 */
import { randomUUID } from "node:crypto";
import { appConfig } from "../config";
import { sqliteDb } from "../db/sqlite";
import { estimateTokensFromChars } from "./agentTelemetryRepository";
import type { UsageProfile } from "../types";
import { finishAppSpan, startAppSpan } from "../observability/telemetry";
import type { Span } from "@opentelemetry/api";

export type ModelUsageLease = {
  eventId: string;
  inputTokens: number;
  reservedTokens: number;
  span: Span;
  release: () => void;
};

export class ModelBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelBudgetExceededError";
  }
}

export class LocalRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRateLimitError";
  }
}

const activeByModel = new Map<string, number>();
const waitersByModel = new Map<string, Array<() => void>>();

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function outputBudgetForProfile(profile: UsageProfile = "balanced"): number {
  const configured = finitePositive(appConfig.modelUsage.reservedOutputTokens, 4_096);
  if (profile === "economy") return Math.min(configured, 2_048);
  if (profile === "performance") return Math.max(configured, 8_192);
  return configured;
}

function usagePolicy(profile: UsageProfile = "balanced") {
  return {
    rpm: finitePositive(appConfig.modelUsage.requestsPerMinute, 60),
    tpm: finitePositive(appConfig.modelUsage.tokensPerMinute, 60_000),
    concurrency: finitePositive(appConfig.modelUsage.maxConcurrent, 4),
    dailyTokens: finitePositive(appConfig.modelUsage.userDailyTokens, 500_000),
    reservedOutputTokens: outputBudgetForProfile(profile)
  };
}

export function estimateModelInputTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    chars += typeof content === "string" ? content.length : JSON.stringify(content ?? "").length;
  }
  return estimateTokensFromChars(chars);
}

async function acquireConcurrency(key: string, maximum: number): Promise<() => void> {
  if ((activeByModel.get(key) ?? 0) >= maximum) {
    await new Promise<void>((resolve) => {
      const queue = waitersByModel.get(key) ?? [];
      queue.push(resolve);
      waitersByModel.set(key, queue);
    });
  }
  activeByModel.set(key, (activeByModel.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeByModel.set(key, Math.max(0, (activeByModel.get(key) ?? 1) - 1));
    const queue = waitersByModel.get(key);
    const next = queue?.shift();
    if (!queue?.length) waitersByModel.delete(key);
    next?.();
  };
}

function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function startOfUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function reserveModelCall(input: {
  providerId: string;
  modelId: string;
  userId: string;
  threadId: string;
  turnId?: string;
  inputTokens: number;
  usageProfile?: UsageProfile;
}): Promise<ModelUsageLease> {
  const policy = usagePolicy(input.usageProfile);
  const key = `${input.providerId}:${input.modelId}`;
  const release = await acquireConcurrency(key, policy.concurrency);
  const now = new Date();
  const nowIso = now.toISOString();
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const reservedTokens = Math.max(1, input.inputTokens) + policy.reservedOutputTokens;
  const span = startAppSpan("llm.model_call", {
    "gen_ai.provider.name": input.providerId,
    "gen_ai.request.model": input.modelId,
    "gen_ai.usage.input_tokens": input.inputTokens,
    "kimibai.user.id": input.userId,
    "kimibai.thread.id": input.threadId,
    "kimibai.turn.id": input.turnId || ""
  });

  try {
    const minuteUsage = sqliteDb.prepare(`
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(CASE
          WHEN input_tokens + output_tokens > reserved_tokens
          THEN input_tokens + output_tokens
          ELSE reserved_tokens
        END), 0) AS tokens
      FROM model_usage_events
      WHERE provider_id = ? AND model_id = ? AND created_at >= ?
    `).get(input.providerId, input.modelId, minuteAgo) as { requests: number; tokens: number };

    if (minuteUsage.requests >= policy.rpm) {
      throw new LocalRateLimitError(`已达到本应用每分钟 ${policy.rpm} 次模型请求上限，请稍后再试。`);
    }
    if (minuteUsage.tokens + reservedTokens > policy.tpm) {
      throw new LocalRateLimitError(`本次请求将超过每分钟 ${policy.tpm} Token 的安全上限，请缩短上下文或稍后再试。`);
    }

    const daily = sqliteDb.prepare(`
      SELECT COALESCE(SUM(CASE
        WHEN input_tokens + output_tokens > reserved_tokens
        THEN input_tokens + output_tokens
        ELSE reserved_tokens
      END), 0) AS tokens
      FROM model_usage_events
      WHERE user_id = ? AND created_at >= ?
    `).get(input.userId, startOfUtcDay(now)) as { tokens: number };
    if (daily.tokens + reservedTokens > policy.dailyTokens) {
      throw new ModelBudgetExceededError(`已达到当前用户每日 ${policy.dailyTokens} Token 的安全预算。`);
    }

    const eventId = randomUUID();
    sqliteDb.prepare(`
      INSERT INTO model_usage_events (
        event_id, provider_id, model_id, user_id, thread_id, turn_id,
        input_tokens, output_tokens, reserved_tokens, estimated_cost_usd,
        pricing_configured, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'reserved', ?)
    `).run(
      eventId,
      input.providerId,
      input.modelId,
      input.userId,
      input.threadId,
      input.turnId ?? null,
      input.inputTokens,
      reservedTokens,
      0,
      0,
      nowIso
    );
    return { eventId, inputTokens: input.inputTokens, reservedTokens, span, release };
  } catch (error) {
    finishAppSpan(span, "failed");
    release();
    throw error;
  }
}

export function completeModelCall(
  lease: ModelUsageLease,
  usage: { inputTokens?: number; outputTokens?: number },
  status: "succeeded" | "failed"
): void {
  const inputTokens = Math.max(0, usage.inputTokens ?? lease.inputTokens);
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  sqliteDb.prepare(`
    UPDATE model_usage_events
    SET input_tokens = ?, output_tokens = ?, estimated_cost_usd = ?,
        status = ?, completed_at = ?
    WHERE event_id = ?
  `).run(
    inputTokens,
    outputTokens,
    0,
    status,
    new Date().toISOString(),
    lease.eventId
  );
  finishAppSpan(lease.span, status, {
    "gen_ai.usage.input_tokens": inputTokens,
    "gen_ai.usage.output_tokens": outputTokens,
    "kimibai.usage.total_tokens": inputTokens + outputTokens
  });
  lease.release();
}

export function extractModelUsage(response: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!response || typeof response !== "object") return {};
  const candidate = response as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
    content?: unknown;
  };
  const usage = candidate.usage_metadata;
  const outputChars = typeof candidate.content === "string"
    ? candidate.content.length
    : JSON.stringify(candidate.content ?? "").length;
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens ?? estimateTokensFromChars(outputChars)
  };
}

export function getModelUsageSummary(userId: string) {
  const now = new Date();
  const daily = sqliteDb.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens
    FROM model_usage_events
    WHERE user_id = ? AND created_at >= ?
  `).get(userId, startOfUtcDay(now));
  const monthly = sqliteDb.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens
    FROM model_usage_events
    WHERE user_id = ? AND created_at >= ?
  `).get(userId, startOfUtcMonth(now));
  const dailyTrend = sqliteDb.prepare(`
    SELECT
      substr(created_at, 1, 10) AS date,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens
    FROM model_usage_events
    WHERE user_id = ? AND created_at >= ?
    GROUP BY substr(created_at, 1, 10)
    ORDER BY date ASC
  `).all(userId, new Date(now.getTime() - 29 * 24 * 60 * 60 * 1_000).toISOString());
  const byModel = sqliteDb.prepare(`
    SELECT
      provider_id AS providerId, model_id AS modelId,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens
    FROM model_usage_events
    WHERE user_id = ? AND created_at >= ?
    GROUP BY provider_id, model_id
    ORDER BY inputTokens + outputTokens DESC
  `).all(userId, startOfUtcMonth(now));
  return {
    userDaily: daily,
    userMonthly: monthly,
    dailyTrend,
    byModel,
    limits: {
      userDailyTokens: usagePolicy().dailyTokens
    }
  };
}

export function getTurnModelUsage(userId: string, threadId: string, turnId: string) {
  return sqliteDb.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedRequests
    FROM model_usage_events
    WHERE user_id = ? AND thread_id = ? AND turn_id = ?
  `).get(userId, threadId, turnId);
}
