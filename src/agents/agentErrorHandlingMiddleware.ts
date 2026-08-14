/**
 * 模型调用与工具调用的统一错误边界。
 *
 * 为什么放在 Middleware：所有主 Agent 工具和模型请求都会经过这里，新增工具时
 * 不需要再次复制 try/catch，同时保证错误分类、脱敏、重试和观测格式一致。
 */
import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { AgentContextSchema, type AgentContext } from "./agentContext";
import {
  AgentRetryExhaustedError,
  isRetryableSubAgentError,
  runWithControlledRetry
} from "./dynamicSubAgentDispatcher";
import { recordAgentEvent } from "./agentTelemetryRepository";
import { appConfig } from "../config";
import {
  completeModelCall,
  estimateModelInputTokens,
  extractModelUsage,
  LocalRateLimitError,
  ModelBudgetExceededError,
  reserveModelCall
} from "./modelUsageController";

export type AgentErrorCategory =
  | "authentication"
  | "permission"
  | "billing"
  | "budget"
  | "rate_limit"
  | "network"
  | "service"
  | "timeout"
  | "cancelled"
  | "approval"
  | "conflict"
  | "not_found"
  | "validation"
  | "unknown";

export interface NormalizedAgentError {
  category: AgentErrorCategory;
  userMessage: string;
  retryable: boolean;
  safeDetail: string;
}

const READ_ONLY_RETRYABLE_TOOLS = new Set([
  "get_weather",
  "calculator",
  "current_time",
  "recall_preference",
  "knowledge_base_search",
  "uploaded_document_search",
  "parallel_read",
  "list_workspace_files",
  "read_workspace_file"
]);

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "未知错误";
}

function structuredErrorText(error: unknown): string {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  return [
    error instanceof Error ? error.name : "",
    rawErrorMessage(error),
    record.status,
    record.code,
    record.type
  ].join(" ");
}

/** 删除密钥、Authorization Header 和 URL 查询参数，防止错误日志泄露凭据。 */
export function sanitizeErrorDetail(error: unknown): string {
  return rawErrorMessage(error)
    .replace(/\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi, "[已隐藏密钥]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/([?&](?:api_?key|token|access_?token)=)[^&\s]+/gi, "$1[已隐藏]")
    .slice(0, 600);
}

export function normalizeAgentError(error: unknown): NormalizedAgentError {
  const safeDetail = sanitizeErrorDetail(error);
  const value = structuredErrorText(error).toLowerCase();
  const retryable = isRetryableSubAgentError(error);

  if (error instanceof AgentRetryExhaustedError) {
    return {
      category: "cancelled",
      userMessage: safeDetail,
      retryable: false,
      safeDetail
    };
  }
  if (error instanceof ModelBudgetExceededError) {
    return {
      category: "budget",
      userMessage: safeDetail,
      retryable: false,
      safeDetail
    };
  }
  if (error instanceof LocalRateLimitError) {
    return {
      category: "rate_limit",
      userMessage: safeDetail,
      retryable: false,
      safeDetail
    };
  }

  if (/credit[_ ]balance[_ ]exhausted|organization[_ ]spend[_ ]limit[_ ]exceeded|project[_ ]spend[_ ]limit[_ ]exceeded|organization[_ ]usage[_ ]limit[_ ]exceeded|insufficient[_ ]quota/.test(value)) {
    return {
      category: "billing",
      userMessage: "模型服务的余额、消费额度或使用额度已耗尽，请调整账户额度后再试。",
      retryable: false,
      safeDetail
    };
  }
  if (/401|authenticationerror|invalid authentication|incorrect api key|api.?key|unauthorized/.test(value)) {
    return {
      category: "authentication",
      userMessage: "模型或服务认证失败，请检查对应的 API Key 和接口地址。",
      retryable: false,
      safeDetail
    };
  }
  if (/403|permissiondeniederror|forbidden|country.+not supported|ip not authorized/.test(value)) {
    return {
      category: "permission",
      userMessage: "当前 API Key、项目、地区或网络地址没有访问该服务的权限。",
      retryable: false,
      safeDetail
    };
  }
  if (/429|rate.?limit|too many requests/.test(value)) {
    return {
      category: "rate_limit",
      userMessage: "服务请求过于频繁，请稍后再试。",
      retryable: true,
      safeDetail
    };
  }
  if (/abort|cancel|用户停止|主任务已停止|已自动中断/.test(value)) {
    return {
      category: "cancelled",
      userMessage: "任务已停止。",
      retryable: false,
      safeDetail
    };
  }
  if (/apitimeouterror|timeout|timed out|etimedout|超时/.test(value)) {
    return {
      category: "timeout",
      userMessage: "请求处理超时；系统会在安全范围内重试，仍失败时自动停止。",
      retryable,
      safeDetail
    };
  }
  if (/approval|批准|拒绝/.test(value)) {
    return {
      category: "approval",
      userMessage: "操作未获得批准，已停止执行。",
      retryable: false,
      safeDetail
    };
  }
  if (/409|conflicterror|conflict|冲突|changed after|发生了变化/.test(value)) {
    return {
      category: "conflict",
      userMessage: "文件已被其他操作修改，请重新读取最新内容后再继续。",
      retryable: false,
      safeDetail
    };
  }
  if (/404|notfounderror|not found|不存在/.test(value)) {
    return {
      category: "not_found",
      userMessage: "请求的模型、文件或资源不存在，请检查名称和标识。",
      retryable: false,
      safeDetail
    };
  }
  if (/apiconnectionerror|econn|network|socket|fetch failed|dns|ssl|certificate/.test(value)) {
    return {
      category: "network",
      userMessage: "网络连接暂时不可用，请检查网络后重试。",
      retryable,
      safeDetail
    };
  }
  if (/5\d\d|service unavailable|bad gateway|temporar/.test(value)) {
    return {
      category: "service",
      userMessage: "模型或工具服务暂时不可用，请稍后再试。",
      retryable,
      safeDetail
    };
  }
  if (/400|422|badrequesterror|unprocessableentityerror|invalid|required|必须|缺少|不支持|只能|无效/.test(value)) {
    return {
      category: "validation",
      userMessage: safeDetail,
      retryable: false,
      safeDetail
    };
  }
  return {
    category: "unknown",
    userMessage: "执行过程中出现错误，本次操作已安全停止。",
    retryable,
    safeDetail
  };
}

export class UnifiedModelCallError extends Error {
  readonly normalized: NormalizedAgentError;

  constructor(error: unknown) {
    const normalized = normalizeAgentError(error);
    super(normalized.userMessage, { cause: error });
    this.name = "UnifiedModelCallError";
    this.normalized = normalized;
  }
}

function telemetryContext(context: AgentContext): AgentContext {
  return context;
}

export const agentErrorHandlingMiddleware = createMiddleware({
  name: "agentErrorHandlingMiddleware",
  contextSchema: AgentContextSchema,

  wrapModelCall: async (request, handler) => {
    const startedAt = Date.now();
    const context = telemetryContext(request.runtime.context);
    try {
      const invocation = await runWithControlledRetry({
        execute: async () => {
          const lease = await reserveModelCall({
            providerId: context.providerId ?? "unknown-provider",
            modelId: context.modelId ?? "unknown-model",
            userId: context.userId,
            threadId: context.threadId,
            turnId: context.turnId,
            usageProfile: context.usageProfile,
            inputTokens: estimateModelInputTokens([
              ...request.messages,
              { content: request.systemPrompt },
              {
                content: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description
                }))
              }
            ])
          });
          try {
            const response = await Promise.resolve(handler(request));
            completeModelCall(lease, extractModelUsage(response), "succeeded");
            return response;
          } catch (error) {
            completeModelCall(lease, {}, "failed");
            throw error;
          }
        },
        maxRetries: 4,
        maxElapsedMs: appConfig.modelUsage.retryTimeBudgetMs,
        onRetry: (attempt, error) => {
          const normalized = normalizeAgentError(error);
          recordAgentEvent({
            threadId: context.threadId,
            userId: context.userId,
            turnId: context.turnId,
            eventType: "model_retry",
            status: "retrying",
            metadata: { attempt, category: normalized.category }
          });
        }
      });
      recordAgentEvent({
        threadId: context.threadId,
        userId: context.userId,
        turnId: context.turnId,
        eventType: "model_call",
        status: "succeeded",
        durationMs: Date.now() - startedAt,
        metadata: { attempts: invocation.attempts }
      });
      return invocation.value;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      recordAgentEvent({
        threadId: context.threadId,
        userId: context.userId,
        turnId: context.turnId,
        eventType: "model_call",
        status: error instanceof AgentRetryExhaustedError ? "interrupted" : "failed",
        durationMs: Date.now() - startedAt,
        metadata: {
          category: normalized.category,
          detail: normalized.safeDetail
        }
      });
      throw new UnifiedModelCallError(error);
    }
  },

  wrapToolCall: async (request, handler) => {
    const startedAt = Date.now();
    const context = telemetryContext(request.runtime.context);
    const toolName = String(request.tool?.name ?? request.toolCall.name ?? "unknown_tool");
    try {
      const invocation = READ_ONLY_RETRYABLE_TOOLS.has(toolName)
        ? await runWithControlledRetry({
            execute: () => Promise.resolve(handler(request)),
            maxRetries: 4,
            onRetry: (attempt, error) => {
              const normalized = normalizeAgentError(error);
              recordAgentEvent({
                threadId: context.threadId,
                userId: context.userId,
                turnId: context.turnId,
                eventType: "tool_retry",
                status: "retrying",
                metadata: { toolName, attempt, category: normalized.category }
              });
            }
          })
        : { value: await handler(request), attempts: 1 };

      recordAgentEvent({
        threadId: context.threadId,
        userId: context.userId,
        turnId: context.turnId,
        eventType: "tool_call",
        status: "succeeded",
        durationMs: Date.now() - startedAt,
        metadata: { toolName, attempts: invocation.attempts }
      });
      return invocation.value;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      recordAgentEvent({
        threadId: context.threadId,
        userId: context.userId,
        turnId: context.turnId,
        eventType: "tool_call",
        status: error instanceof AgentRetryExhaustedError ? "interrupted" : "failed",
        durationMs: Date.now() - startedAt,
        metadata: {
          toolName,
          category: normalized.category,
          detail: normalized.safeDetail
        }
      });

      // 工具错误作为 ToolMessage 返回给 Agent，让它可以解释限制或选择其他方案；
      // 不返回堆栈、API Key、绝对路径等内部诊断信息。
      return new ToolMessage({
        content: JSON.stringify({
          ok: false,
          error: normalized.userMessage,
          category: normalized.category,
          retryable: normalized.retryable
        }),
        tool_call_id: request.toolCall.id ?? "unknown-tool-call",
        name: toolName
      });
    }
  }
});
