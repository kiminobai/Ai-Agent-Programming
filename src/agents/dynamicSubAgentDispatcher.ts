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
  normalizeWorkspaceScopePath,
  workspaceScopesOverlap
} from "../workspace/workspaceDelegationPolicy";

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

type AgentTool = NonNullable<Parameters<typeof createAgent>[0]["tools"]>[number] & {
  name: string;
};
type DispatchMode = "consult" | "execute";

const DispatchTaskSchema = z.object({
  id: z.string().min(1).max(80),
  specialistId: z.string().min(1).describe("当前角色允许的子代理 id。"),
  task: z.string().min(1).max(MAX_TASK_CHARS),
  context: z.string().max(MAX_CONTEXT_CHARS).optional(),
  expectedOutput: z.string().max(600).optional(),
  allowedPaths: z.array(z.string().min(1)).max(20).optional()
});

type DispatchTask = z.infer<typeof DispatchTaskSchema>;
type DispatchInput = {
  tasks: DispatchTask[];
  maxConcurrency?: number;
  timeoutMs?: number;
  resultBudgetChars?: number;
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

function assertNoWriteConflicts(tasks: DispatchTask[]): void {
  for (let left = 0; left < tasks.length; left += 1) {
    const leftPaths = (tasks[left].allowedPaths ?? []).map(normalizeWorkspaceScopePath);
    for (let right = left + 1; right < tasks.length; right += 1) {
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
          assertNoWriteConflicts(tasks);
        }
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
        const batchResultBudget = Math.max(
          2_000,
          Math.min(resultBudgetChars ?? DEFAULT_BATCH_RESULT_CHARS, MAX_BATCH_RESULT_CHARS)
        );
        const resultLimit = Math.min(
          MAX_RESULT_CHARS,
          Math.max(800, Math.floor(batchResultBudget / tasks.length))
        );
        const startedAt = Date.now();

        const results = await mapWithConcurrency(tasks, concurrency, async (task) => {
          runtime.signal?.throwIfAborted();
          const definition = workflow.subAgents.find((item) => item.id === task.specialistId);
          if (!definition) {
            return { id: task.id, status: "failed" as const, error: "未授权的子代理类型。" };
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
                ? "仅可修改明确授权的相对路径，并执行最小必要验证。"
                : "这是只读任务，禁止写文件、运行副作用命令或写入记忆。"
            ].join("\n")
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
            const result = await child.invoke(
              {
                messages: [new HumanMessage([
                  `任务：${task.task}`,
                  task.context ? `必要上下文：${task.context}` : "",
                  task.expectedOutput ? `期望结果：${task.expectedOutput}` : "",
                  mode === "execute" ? `允许写入：${(task.allowedPaths ?? []).join("、")}` : ""
                ].filter(Boolean).join("\n"))]
              },
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
            const output = latestText(result, resultLimit);
            finishSubAgentRun(run.runId, "succeeded");
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
        });

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
          ? "将多个互不依赖的编码或验证任务动态委派给专职子代理并受控并行执行。整批执行前需要用户审批。"
          : "将多个互不依赖的研究、分析或审核任务动态委派给专职子代理并异步并行执行。简单任务不要使用。",
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
            .describe("整批子任务可返回给主管的最大字符预算。")
        })
      }
    ) as AgentTool;

  return [buildTool("consult"), buildTool("execute")];
}
