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

export type AgentErrorCategory =
  | "authentication"
  | "rate_limit"
  | "network"
  | "service"
  | "timeout"
  | "cancelled"
  | "approval"
  | "conflict"
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
  const value = safeDetail.toLowerCase();
  const retryable = isRetryableSubAgentError(error);

  if (error instanceof AgentRetryExhaustedError) {
    return {
      category: "cancelled",
      userMessage: safeDetail,
      retryable: false,
      safeDetail
    };
  }

  if (/401|403|invalid authentication|api.?key|unauthorized|forbidden/.test(value)) {
    return {
      category: "authentication",
      userMessage: "模型或服务认证失败，请检查对应的 API Key 和接口地址。",
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
  if (/timeout|timed out|etimedout|超时/.test(value)) {
    return {
      category: "timeout",
      userMessage: "请求处理超时，任务已停止。",
      retryable: false,
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
  if (/conflict|冲突|changed after|发生了变化/.test(value)) {
    return {
      category: "conflict",
      userMessage: "文件已被其他操作修改，请重新读取最新内容后再继续。",
      retryable: false,
      safeDetail
    };
  }
  if (/econn|network|socket|fetch failed|dns/.test(value)) {
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
  if (/invalid|required|必须|缺少|不支持|只能|无效/.test(value)) {
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
        execute: () => Promise.resolve(handler(request)),
        maxRetries: 4,
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
