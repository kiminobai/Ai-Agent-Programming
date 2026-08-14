/**
 * 运行时子代理调度器。
 *
 * 主 Agent 一次提交多个互不依赖的子任务；调度器负责并发上限、超时、
 * 结果长度预算和失败隔离。子代理是当前 turn 的内部运行单元，不创建 Thread。
 */
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import type { RoleSubAgentDefinition, RoleWorkflowAgent } from "../workflows-agents/types";
import type { ToolMemoryRuntime } from "./toolMemoryState";
import type { AgentContext } from "./agentContext";
import { AgentContextSchema } from "./agentContext";
import { ToolMemoryState } from "./toolMemoryState";
import { getThreadById } from "../threads/threadRepository";
import {
  finishSubAgentRun,
  startSubAgentRun
} from "./subAgentRunRepository";
import {
  appendAgentMessage,
  createCollaborationPlan,
  readBlackboardResults,
  updateCollaborationTask,
  writeBlackboardResult
} from "./agentCollaborationRepository";
import {
  normalizeWorkspaceScopePath,
  workspaceScopesOverlap
} from "../workspace/workspaceDelegationPolicy";
import {
  recordAgentEvent,
  saveAgentTaskMetrics
} from "./agentTelemetryRepository";

const INTERNAL_SUB_AGENT_TAG = "internal-role-sub-agent";
const MAX_TASKS = 6;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 4;
const MAX_TASK_CHARS = 1_200;
const MAX_CONTEXT_CHARS = 4_000;
const MAX_RESULT_CHARS = 5_000;
const MAX_BATCH_CONTEXT_CHARS = 12_000;
const DEFAULT_BATCH_RESULT_CHARS = 12_000;
const MAX_BATCH_RESULT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 180_000;
// 学习点：总尝试次数包含首次执行。这里采用“首次 1 次 + 最多重试 4 次”，
// 连续失败 5 次后必须中断，避免瞬时错误演变成无限重试和 Token 浪费。
const DEFAULT_MAX_RETRIES = 4;
const MAX_RETRIES = 4;

type AgentTool = NonNullable<Parameters<typeof createAgent>[0]["tools"]>[number] & {
  name: string;
};
type DispatchMode = "consult" | "execute";

const DispatchTaskSchema = z.object({
  id: z.string().min(1).max(80),
  specialistId: z.string().min(1).describe("当前角色允许的子代理 id。"),
  kind: z
    .enum(["research", "implementation", "review", "test"])
    .default("research")
    .describe("子任务类型，用于让主管明确研究、实现、审核或测试边界。"),
  task: z.string().min(1).max(MAX_TASK_CHARS),
  context: z.string().max(MAX_CONTEXT_CHARS).optional(),
  expectedOutput: z.string().max(600).optional(),
  allowedPaths: z.array(z.string().min(1)).max(20).optional(),
  dependsOn: z
    .array(z.string().min(1).max(80))
    .max(MAX_TASKS)
    .default([])
    .describe("必须先成功完成的子任务 id；无依赖任务会受控并行执行。")
});

type DispatchTask = z.infer<typeof DispatchTaskSchema>;
type DispatchInput = {
  tasks: DispatchTask[];
  maxConcurrency?: number;
  timeoutMs?: number;
  resultBudgetChars?: number;
  maxRetries?: number;
};
type DispatchResult = {
  id: string;
  specialistId: string;
  status: "succeeded" | "failed" | "blocked" | "timed_out" | "cancelled";
  output?: string;
  error?: string;
};

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    )
    .join("");
}

function latestText(result: unknown, maxChars: number): string {
  const messages =
    result && typeof result === "object" && "messages" in result
      ? (result as { messages?: Array<{ content?: unknown }> }).messages ?? []
      : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractText(messages[index]?.content).trim();
    if (text) return text.slice(0, Math.min(maxChars, MAX_RESULT_CHARS));
  }
  throw new Error("子代理没有返回有效结果。");
}

export function validateTaskGraph(tasks: DispatchTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`子任务 id 重复：${task.id}。`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) throw new Error(`子任务 ${task.id} 不能依赖自身。`);
      if (!ids.has(dependencyId)) {
        throw new Error(`子任务 ${task.id} 依赖不存在的任务 ${dependencyId}。`);
      }
    }
  }

  // 学习点：拓扑遍历用于提前发现循环依赖，避免所有任务一直等待。
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error(`子任务依赖形成循环：${taskId}。`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId)?.dependsOn ?? []) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

export function isRetryableSubAgentError(error: unknown): boolean {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const message = [
    error instanceof Error ? error.name : "",
    error instanceof Error ? error.message : String(error),
    record.status,
    record.code,
    record.type
  ].join(" ").toLowerCase();
  if (
    /auth|401|403|approval|批准|拒绝|conflict|冲突|changed after|发生了变化|abort|cancel|停止|credit[_ ]balance[_ ]exhausted|spend[_ ]limit|usage[_ ]limit|insufficient[_ ]quota/.test(
      message
    )
  ) return false;
  return /429|rate.?limit|too many requests|5\d\d|apiconnectionerror|apitimeouterror|econnreset|econnrefused|etimedout|timeout|超时|network|socket|fetch failed|temporar/.test(
    message
  );
}

export function getRetryDelayMs(error: unknown, attempt: number): number {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const headers = record.headers;
  let retryAfter: string | null | undefined;
  if (headers && typeof headers === "object" && "get" in headers) {
    retryAfter = (headers as { get(name: string): string | null }).get("retry-after");
  } else if (headers && typeof headers === "object") {
    const plainHeaders = headers as Record<string, unknown>;
    retryAfter = String(plainHeaders["retry-after"] ?? plainHeaders["Retry-After"] ?? "") || undefined;
  }

  let retryAfterMs = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1_000)
      : Math.max(0, Date.parse(retryAfter) - Date.now());
  }
  const exponentialBackoff = 400 * 2 ** Math.max(0, attempt - 1);
  // 服务端 Retry-After 优先；设置单次等待上限，避免异常 Header 永久挂起任务。
  return Math.min(60_000, Math.max(retryAfterMs, exponentialBackoff) + Math.floor(Math.random() * 150));
}

export class AgentRetryExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`任务连续失败 ${attempts} 次，已自动中断，避免继续重复执行。`, {
      cause
    });
    this.name = "AgentRetryExhaustedError";
    this.attempts = attempts;
  }
}

export async function runWithControlledRetry<T>(input: {
  execute: () => Promise<T>;
  maxRetries: number;
  maxElapsedMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: unknown) => void;
}): Promise<{ value: T; attempts: number }> {
  let attempts = 0;
  const startedAt = Date.now();
  const maxElapsedMs = input.maxElapsedMs ?? 120_000;
  while (true) {
    input.signal?.throwIfAborted();
    attempts += 1;
    try {
      return { value: await input.execute(), attempts };
    } catch (error) {
      if (!isRetryableSubAgentError(error)) throw error;
      if (attempts > input.maxRetries) {
        throw new AgentRetryExhaustedError(attempts, error);
      }
      input.onRetry?.(attempts, error);
      const delayMs = getRetryDelayMs(error, attempts);
      if (Date.now() - startedAt + delayMs > maxElapsedMs) {
        throw new AgentRetryExhaustedError(attempts, error);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        input.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("主任务已停止。"));
        }, { once: true });
      });
    }
  }
}

function transitivelyDependsOn(
  task: DispatchTask,
  possibleDependencyId: string,
  byId: Map<string, DispatchTask>,
  seen = new Set<string>()
): boolean {
  if (task.dependsOn.includes(possibleDependencyId)) return true;
  for (const dependencyId of task.dependsOn) {
    if (seen.has(dependencyId)) continue;
    seen.add(dependencyId);
    const dependency = byId.get(dependencyId);
    if (dependency && transitivelyDependsOn(dependency, possibleDependencyId, byId, seen)) return true;
  }
  return false;
}

function assertNoParallelWriteConflicts(tasks: DispatchTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (let left = 0; left < tasks.length; left += 1) {
    const leftPaths = (tasks[left].allowedPaths ?? []).map(normalizeWorkspaceScopePath);
    for (let right = left + 1; right < tasks.length; right += 1) {
      // 有依赖关系的任务必定串行，因此可以依次修改同一个文件。
      if (
        transitivelyDependsOn(tasks[left], tasks[right].id, byId) ||
        transitivelyDependsOn(tasks[right], tasks[left].id, byId)
      ) continue;
      const rightPaths = (tasks[right].allowedPaths ?? []).map(normalizeWorkspaceScopePath);
      if (leftPaths.some((a) => rightPaths.some((b) => workspaceScopesOverlap(a, b)))) {
        throw new Error(
          `子任务 ${tasks[left].id} 与 ${tasks[right].id} 的写入范围重叠，必须改为串行执行。`
        );
      }
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function createDynamicSubAgentTools(
  model: ChatOpenAI,
  workflow: RoleWorkflowAgent | undefined,
  availableTools: AgentTool[]
): AgentTool[] {
  if (!workflow?.subAgents.length) return [];

  const buildTool = (mode: DispatchMode) =>
    tool(
      async (input: DispatchInput, runtime: ToolMemoryRuntime) => {
        const { tasks, maxConcurrency, timeoutMs, resultBudgetChars } = input;
        const context = (runtime.context ?? {}) as AgentContext;
        if (!context.userId || !context.threadId || !context.turnId) {
          throw new Error("动态子代理调度缺少 userId、threadId 或 turnId。");
        }
        const thread = getThreadById(context.threadId, context.userId);
        if (mode === "execute" && thread?.mode !== "work") {
          throw new Error("执行型动态子代理只能用于绑定工作区的 Work 任务。");
        }
        if (mode === "execute") {
          if (tasks.some((task) => !(task.allowedPaths?.length))) {
            throw new Error("每个执行型子任务都必须声明至少一个允许写入的相对路径。");
          }
          assertNoParallelWriteConflicts(tasks);
        }
        validateTaskGraph(tasks);
        const totalContextChars = tasks.reduce(
          (total, task) => total + task.task.length + (task.context?.length ?? 0),
          0
        );
        if (totalContextChars > MAX_BATCH_CONTEXT_CHARS) {
          throw new Error(
            `动态子任务上下文总量超过 ${MAX_BATCH_CONTEXT_CHARS} 字符，请缩小任务范围。`
          );
        }

        const concurrency = Math.max(1, Math.min(maxConcurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
        const taskTimeout = Math.max(5_000, Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
        // 执行型子代理可能已调用写文件或命令工具，整轮重试会重复副作用。
        const retryLimit = mode === "execute"
          ? 0
          : Math.max(0, Math.min(input.maxRetries ?? DEFAULT_MAX_RETRIES, MAX_RETRIES));
        const batchResultBudget = Math.max(
          2_000,
          Math.min(resultBudgetChars ?? DEFAULT_BATCH_RESULT_CHARS, MAX_BATCH_RESULT_CHARS)
        );
        const resultLimit = Math.min(
          MAX_RESULT_CHARS,
          Math.max(800, Math.floor(batchResultBudget / tasks.length))
        );
        const startedAt = Date.now();

        createCollaborationPlan({
          threadId: context.threadId,
          turnId: context.turnId,
          userId: context.userId,
          mode,
          tasks: tasks.map((task) => ({
            id: task.id,
            specialistId: task.specialistId,
            task: task.task,
            dependsOn: task.dependsOn,
            allowedPaths: task.allowedPaths
          }))
        });

        const executeTask = async (task: DispatchTask): Promise<DispatchResult> => {
          const taskStartedAt = Date.now();
          let attempts = 0;
          runtime.signal?.throwIfAborted();
          const definition = workflow.subAgents.find((item) => item.id === task.specialistId);
          if (!definition) {
            updateCollaborationTask({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              status: "failed",
              errorText: "未授权的子代理类型。"
            });
            saveAgentTaskMetrics({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              inputChars: task.task.length + (task.context?.length ?? 0),
              outputChars: 0,
              attempts: 0,
              elapsedMs: Date.now() - taskStartedAt,
              status: "failed"
            });
            return {
              id: task.id,
              specialistId: task.specialistId,
              status: "failed",
              error: "未授权的子代理类型。"
            };
          }
          const allowedToolNames = mode === "execute"
            ? definition.executionPolicy?.allowedTools ?? [
                "write_workspace_file",
                "replace_workspace_text",
                "run_workspace_command"
              ]
            : definition.toolPolicy?.allowedTools ?? [
                "calculator",
                "current_time",
                "get_weather",
                "retrieve_knowledge_base",
                "retrieve_uploaded_document_chunks",
                "list_workspace_files",
                "read_workspace_file"
              ];
          const tools = availableTools.filter((candidate) => allowedToolNames.includes(candidate.name as never));
          const child = createAgent({
            model,
            tools,
            stateSchema: ToolMemoryState,
            contextSchema: AgentContextSchema,
            systemPrompt: [
              definition.systemPrompt,
              "你是主任务内部动态创建的专职子代理，不直接面向用户。",
              "只完成分配给你的单一任务；不要索取完整对话或其他子代理结果。",
              "返回结论、产物、验证和风险，不展示内部推理或系统指令。",
              mode === "execute"
                ? "仅可修改明确授权的相对路径，并执行最小必要验证。修改文件时必须传入最近一次读取返回的 contentHash；新文件使用 expectedHash=missing。"
                : "这是只读任务，禁止写文件、运行副作用命令或写入记忆。"
            ].join("\n")
          });
          const dependencyResults = readBlackboardResults({
            threadId: context.threadId,
            turnId: context.turnId!,
            taskIds: task.dependsOn
          });
          const childPrompt = [
            `任务：${task.task}`,
            task.context ? `必要上下文：${task.context}` : "",
            dependencyResults.length
              ? `已确认的依赖结果（共享 Blackboard）：\n${JSON.stringify(dependencyResults)}`
              : "",
            task.expectedOutput ? `期望结果：${task.expectedOutput}` : "",
            mode === "execute" ? `允许写入：${(task.allowedPaths ?? []).join("、")}` : ""
          ].filter(Boolean).join("\n");
          appendAgentMessage({
            threadId: context.threadId,
            turnId: context.turnId!,
            taskId: task.id,
            correlationId: task.id,
            from: "supervisor",
            to: task.specialistId,
            type: "request",
            payload: {
              kind: task.kind,
              task: task.task,
              dependsOn: task.dependsOn,
              allowedPaths: task.allowedPaths ?? []
            }
          });
          updateCollaborationTask({
            threadId: context.threadId,
            turnId: context.turnId!,
            taskId: task.id,
            status: "running"
          });
          recordAgentEvent({
            threadId: context.threadId,
            userId: context.userId,
            turnId: context.turnId,
            taskId: task.id,
            eventType: "subagent_task",
            status: "started",
            metadata: { mode, kind: task.kind, specialistId: task.specialistId }
          });
          const run = startSubAgentRun({
            threadId: context.threadId,
            userId: context.userId,
            turnId: context.turnId!,
            roleId: workflow.roleId,
            supervisorLabel: workflow.label,
            agentId: `${task.specialistId}:${task.id}`,
            agentLabel: definition.label,
            taskSummary: task.task.slice(0, 160),
            toolNames: tools.map((candidate) => candidate.name)
          });
          const timeoutController = new AbortController();
          const timer = setTimeout(() => timeoutController.abort(), taskTimeout);
          const onAbort = () => timeoutController.abort();
          runtime.signal?.addEventListener("abort", onAbort, { once: true });
          try {
            const invocation = await runWithControlledRetry({
              maxRetries: retryLimit,
              signal: timeoutController.signal,
              onRetry: (attempt, error) => recordAgentEvent({
                threadId: context.threadId,
                userId: context.userId,
                turnId: context.turnId,
                taskId: task.id,
                eventType: "subagent_retry",
                status: "scheduled",
                metadata: {
                  attempt,
                  reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
                }
              }),
              execute: () => {
                attempts += 1;
                return child.invoke(
                  { messages: [new HumanMessage(childPrompt)] },
                  {
                    tags: [INTERNAL_SUB_AGENT_TAG],
                    context: {
                      ...context,
                      workspaceWritePathPrefixes: mode === "execute"
                        ? (task.allowedPaths ?? []).map(normalizeWorkspaceScopePath)
                        : undefined
                    },
                    signal: timeoutController.signal
                  }
                );
              }
            });
            attempts = invocation.attempts;
            const result = invocation.value;
            const output = latestText(result, resultLimit);
            finishSubAgentRun(run.runId, "succeeded");
            const sharedResult = {
              kind: task.kind,
              summary: output,
              producedBy: task.specialistId
            };
            writeBlackboardResult({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              authorAgent: task.specialistId,
              content: sharedResult
            });
            appendAgentMessage({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              correlationId: task.id,
              from: task.specialistId,
              to: "supervisor",
              type: task.kind === "review" ? "feedback" : "result",
              payload: sharedResult
            });
            updateCollaborationTask({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              status: "succeeded",
              resultSummary: output
            });
            const elapsedMs = Date.now() - taskStartedAt;
            saveAgentTaskMetrics({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              inputChars: childPrompt.length * attempts,
              outputChars: output.length,
              attempts,
              elapsedMs,
              status: "succeeded"
            });
            recordAgentEvent({
              threadId: context.threadId,
              userId: context.userId,
              turnId: context.turnId,
              taskId: task.id,
              eventType: "subagent_task",
              status: "succeeded",
              durationMs: elapsedMs,
              metadata: { attempts, outputChars: output.length }
            });
            return { id: task.id, specialistId: task.specialistId, status: "succeeded" as const, output };
          } catch (error) {
            const cancelled = runtime.signal?.aborted;
            const timedOut = timeoutController.signal.aborted && !cancelled;
            const message = cancelled
              ? "主任务已停止。"
              : timedOut
                ? `子任务超过 ${taskTimeout}ms。`
                : error instanceof Error ? error.message : String(error);
            finishSubAgentRun(run.runId, "failed", { errorText: message });
            updateCollaborationTask({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              status: cancelled ? "cancelled" : timedOut ? "timed_out" : "failed",
              errorText: message
            });
            const elapsedMs = Date.now() - taskStartedAt;
            saveAgentTaskMetrics({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              inputChars: childPrompt.length * Math.max(1, attempts),
              outputChars: 0,
              attempts: Math.max(1, attempts),
              elapsedMs,
              status: cancelled ? "cancelled" : timedOut ? "timed_out" : "failed"
            });
            recordAgentEvent({
              threadId: context.threadId,
              userId: context.userId,
              turnId: context.turnId,
              taskId: task.id,
              eventType: "subagent_task",
              status: cancelled ? "cancelled" : timedOut ? "timed_out" : "failed",
              durationMs: elapsedMs,
              metadata: { attempts: Math.max(1, attempts), error: message.slice(0, 300) }
            });
            return {
              id: task.id,
              specialistId: task.specialistId,
              status: cancelled ? "cancelled" as const : timedOut ? "timed_out" as const : "failed" as const,
              error: message
            };
          } finally {
            clearTimeout(timer);
            runtime.signal?.removeEventListener("abort", onAbort);
          }
        };

        // 学习点：每一波只运行依赖已成功的任务；同一波内部并行，波与波之间串行。
        const pending = new Map(tasks.map((task) => [task.id, task]));
        const resultById = new Map<string, Awaited<ReturnType<typeof executeTask>>>();
        while (pending.size > 0) {
          runtime.signal?.throwIfAborted();

          for (const task of [...pending.values()]) {
            const failedDependency = task.dependsOn.find((dependencyId) => {
              const dependency = resultById.get(dependencyId);
              return dependency && dependency.status !== "succeeded";
            });
            if (!failedDependency) continue;
            const blocked = {
              id: task.id,
              specialistId: task.specialistId,
              status: "blocked" as const,
              error: `依赖任务 ${failedDependency} 未成功，当前任务未执行。`
            };
            resultById.set(task.id, blocked);
            pending.delete(task.id);
            updateCollaborationTask({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              status: "blocked",
              errorText: blocked.error
            });
            saveAgentTaskMetrics({
              threadId: context.threadId,
              turnId: context.turnId!,
              taskId: task.id,
              inputChars: task.task.length + (task.context?.length ?? 0),
              outputChars: 0,
              attempts: 0,
              elapsedMs: 0,
              status: "blocked"
            });
          }

          const ready = [...pending.values()]
            .filter((task) => task.dependsOn.every((dependencyId) => resultById.get(dependencyId)?.status === "succeeded"))
            .slice(0, concurrency);
          if (ready.length === 0) {
            if (pending.size === 0) break;
            throw new Error("子代理依赖图无法继续调度，请检查依赖状态。 ");
          }
          const waveResults = await mapWithConcurrency(ready, concurrency, executeTask);
          ready.forEach((task, index) => {
            resultById.set(task.id, waveResults[index]);
            pending.delete(task.id);
          });
        }
        const results = tasks.map((task) => resultById.get(task.id)!);

        return JSON.stringify({
          mode,
          summary: {
            total: results.length,
            succeeded: results.filter((item) => item.status === "succeeded").length,
            failed: results.filter((item) => item.status !== "succeeded").length,
            elapsedMs: Date.now() - startedAt
          },
          results
        });
      },
      {
        name: mode === "execute" ? "execute_dynamic_subagents" : "dispatch_dynamic_subagents",
        description: mode === "execute"
          ? "将编码、验证或审核任务按依赖 DAG 委派给专职子代理；无依赖任务并行，有依赖任务串行。整批执行前需要用户审批。"
          : "将研究、分析或审核任务按依赖 DAG 委派给专职子代理；通过共享 Blackboard 传递结构化结果。简单任务不要使用。",
        schema: z.object({
          tasks: z.array(DispatchTaskSchema).min(2).max(MAX_TASKS),
          maxConcurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional(),
          timeoutMs: z.number().int().min(5_000).max(MAX_TIMEOUT_MS).optional(),
          resultBudgetChars: z
            .number()
            .int()
            .min(2_000)
            .max(MAX_BATCH_RESULT_CHARS)
            .optional()
            .describe("整批子任务可返回给主管的最大字符预算。"),
          maxRetries: z
            .number()
            .int()
            .min(0)
            .max(MAX_RETRIES)
            .optional()
            .describe(
              "瞬时网络、限流或 5xx 错误的最大自动重试次数；默认 4，加上首次执行总共最多尝试 5 次。"
            )
        })
      }
    ) as AgentTool;

  return [buildTool("consult"), buildTool("execute")];
}
