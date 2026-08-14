/**
 * 模型请求的本地限流与成本控制器。
 *
 * 供应商仍然拥有最终限额；本控制器在请求发出前削平并发、限制 RPM/TPM，
 * 并用 SQLite 账本阻止单用户或整套应用意外消耗过多 Token/费用。
 */
import { randomUUID } from "node:crypto";
import { appConfig } from "../config";
import { sqliteDb } from "../db/sqlite";
import { estimateTokensFromChars } from "./agentTelemetryRepository";
import type { UsageProfile } from "../types";

type ModelPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
};

export type ModelUsageLease = {
  eventId: string;
  inputTokens: number;
  reservedTokens: number;
  price?: ModelPrice;
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
    monthlyCostUsd: finitePositive(appConfig.modelUsage.monthlyCostUsd, 10),
    reservedOutputTokens: outputBudgetForProfile(profile)
  };
}

function parsePricing(): Record<string, ModelPrice> {
  try {
    const parsed = JSON.parse(appConfig.modelUsage.pricingJson) as Record<string, Partial<ModelPrice>>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, price]) => {
        const inputPerMillion = Number(price.inputPerMillion);
        const outputPerMillion = Number(price.outputPerMillion);
        return Number.isFinite(inputPerMillion) && inputPerMillion >= 0 &&
          Number.isFinite(outputPerMillion) && outputPerMillion >= 0
          ? [[key, { inputPerMillion, outputPerMillion }]]
          : [];
      })
    );
  } catch {
    return {};
  }
}

function estimateCost(inputTokens: number, outputTokens: number, price?: ModelPrice): number {
  if (!price) return 0;
  return (
    inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion
  ) / 1_000_000;
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
  const price = parsePricing()[key];
  const projectedCost = estimateCost(input.inputTokens, policy.reservedOutputTokens, price);

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

    if (price) {
      const month = sqliteDb.prepare(`
        SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
        FROM model_usage_events
        WHERE pricing_configured = 1 AND created_at >= ?
      `).get(startOfUtcMonth(now)) as { cost: number };
      if (month.cost + projectedCost > policy.monthlyCostUsd) {
        throw new ModelBudgetExceededError(`本次请求将超过每月 $${policy.monthlyCostUsd} 的模型费用预算。`);
      }
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
      projectedCost,
      price ? 1 : 0,
      nowIso
    );
    return { eventId, inputTokens: input.inputTokens, reservedTokens, price, release };
  } catch (error) {
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
    estimateCost(inputTokens, outputTokens, lease.price),
    status,
    new Date().toISOString(),
    lease.eventId
  );
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
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd
    FROM model_usage_events
    WHERE user_id = ? AND created_at >= ?
  `).get(userId, startOfUtcDay(now));
  const monthly = sqliteDb.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd,
      SUM(CASE WHEN pricing_configured = 0 THEN 1 ELSE 0 END) AS unpricedRequests
    FROM model_usage_events
    WHERE created_at >= ?
  `).get(startOfUtcMonth(now));
  return {
    userDaily: daily,
    applicationMonthly: monthly,
    limits: {
      userDailyTokens: usagePolicy().dailyTokens,
      monthlyCostUsd: usagePolicy().monthlyCostUsd
    }
  };
}
