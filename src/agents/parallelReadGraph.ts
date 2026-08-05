/**
 * 单 Agent 的公共并行只读工作流。
 *
 * 这与 Multi-Agent 无关：同一个 Agent 遇到多个互不依赖的数据查询时，
 * 通过一个 LangGraph 同时执行，再把全部结果交回同一个 Agent 汇总。
 * 有副作用的写文件、命令和记忆写入永远不会进入这个并行图。
 */
import {
  END,
  ReducedValue,
  Send,
  START,
  StateGraph,
  StateSchema
} from "@langchain/langgraph";
import { z } from "zod";
import type { ToolMemoryRuntime } from "./toolMemoryState";
import { executeGetWeather } from "../tools/weatherExecutor";
import { executeCurrentTime } from "../tools/currentTimeExecutor";
import { executeCalculator } from "../tools/calculatorExecutor";
import type { AgentContext } from "./agentContext";
import {
  ParallelReadRequestSchema,
  type ParallelReadRequest,
  ScheduledReadResultSchema,
  ScheduledReadTaskSchema,
  type ScheduledReadResult,
  type ScheduledReadTask
} from "./parallelReadTypes";
import { executeDurableTask } from "./durableTaskExecution";

const ParallelReadState = new StateSchema({
  tasks: z.array(ScheduledReadTaskSchema),
  // Map 阶段的多个 Worker 会同时写 results。
  // ReducedValue 把并行分支结果安全合并，而不是发生并发覆盖。
  results: new ReducedValue(
    z.array(ScheduledReadResultSchema).default(() => []),
    {
      reducer: (current, next) => [...current, ...next]
    }
  ),
  aggregatedResults: z.array(ScheduledReadResultSchema).default(() => []),
  maxConcurrency: z.number().int().min(1).max(4),
  wave: z.number().int().nonnegative().default(0)
});

async function executeRequest(
  request: ParallelReadRequest,
  runtime: ToolMemoryRuntime
): Promise<unknown> {
  runtime.signal?.throwIfAborted();
  const context = (runtime.context ?? {}) as AgentContext;

  switch (request.source) {
    case "knowledge_base": {
      // RAG 内部会引用 LangChain Provider，因此执行时再加载，避免启动阶段循环依赖。
      const { retrieveKnowledgeBaseResult } = await import(
        "../tools/langchain/knowledgeBaseTool"
      );
      return retrieveKnowledgeBaseResult(
        request.task,
        request.knowledgeBaseId
      );
    }
    case "uploaded_document": {
      const { retrieveUploadedDocumentResult } = await import(
        "../tools/langchain/uploadedDocumentTool"
      );
      return retrieveUploadedDocumentResult(request.task, context.threadId);
    }
    case "weather":
      return executeGetWeather(
        { location: request.location, unit: request.unit },
        runtime.signal
      );
    case "current_time":
      return executeCurrentTime({ timeZone: request.timeZone });
    case "calculator":
      return executeCalculator({
        operation: request.operation,
        leftOperand: request.leftOperand,
        rightOperand: request.rightOperand
      });
  }
}

export async function runParallelReadGraph(
  tasks: ScheduledReadTask[],
  maxConcurrency: number,
  runtime: ToolMemoryRuntime
): Promise<ScheduledReadResult[]> {
  const graph = new StateGraph(ParallelReadState)
    .addNode("validate_plan", async (state) => {
      if (state.tasks.length < 2) {
        throw new Error("并行查询至少需要两个互不依赖的只读任务。");
      }
      validateTaskGraph(state.tasks);
      return {};
    })
    .addNode("prepare_wave", async (state) => {
      // 先传播失败依赖，避免永远等待一个不可能执行的任务。
      const blocked = collectTransitivelyBlockedTasks(
        state.tasks,
        state.results
      );
      return {
        // Reducer 只追加本轮新产生的 blocked 结果。
        results: blocked,
        wave: state.wave + 1
      };
    })
    .addNode("execute_task", async (workerState: {
      task: ScheduledReadTask;
      completedResults: ScheduledReadResult[];
    }) => {
      // Send 为每个任务创建独立 Worker Node。多个 Worker 在同一 superstep 并行。
      const result = await executeScheduledTask(
        workerState.task,
        new Map(
          workerState.completedResults.map((item) => [item.taskId, item])
        ),
        runtime
      );
      // 每个 Worker 只返回自己的 Map 结果，由 results Reducer 统一合并。
      return { results: [result] };
    })
    .addNode("aggregate_results", async (state) => {
      // Reduce 节点把并发完成顺序恢复成计划顺序，保证最终上下文稳定可复现。
      const order = new Map(
        state.tasks.map((task, index) => [task.id, index])
      );
      return {
        aggregatedResults: [...state.results].sort(
          (left, right) =>
            (order.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.taskId) ?? Number.MAX_SAFE_INTEGER)
        )
      };
    })
    .addEdge(START, "validate_plan")
    .addEdge("validate_plan", "prepare_wave")
    .addConditionalEdges(
      "prepare_wave",
      (state) => dispatchReadyTasks(state)
    )
    // LangGraph 会等待本轮所有 Send Worker 完成，再进入下一 superstep。
    .addEdge("execute_task", "prepare_wave")
    .addEdge("aggregate_results", END)
    .compile({ name: "single-agent-dynamic-read-scheduler" });

  const result = await graph.invoke(
    {
      tasks,
      results: [],
      aggregatedResults: [],
      maxConcurrency,
      wave: 0
    },
    { signal: runtime.signal }
  );
  return result.aggregatedResults as ScheduledReadResult[];
}

function collectTransitivelyBlockedTasks(
  tasks: ScheduledReadTask[],
  existingResults: ScheduledReadResult[]
): ScheduledReadResult[] {
  const resultById = new Map(
    existingResults.map((result) => [result.taskId, result])
  );
  const blocked: ScheduledReadResult[] = [];
  let changed = true;

  // A 失败会阻止 B，B 被阻止后还要继续阻止依赖 B 的 C。
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (resultById.has(task.id)) {
        continue;
      }
      const failedDependency = task.dependsOn.some((dependencyId) => {
        const dependency = resultById.get(dependencyId);
        return dependency && dependency.status !== "succeeded";
      });
      if (!failedDependency) {
        continue;
      }

      const result: ScheduledReadResult = {
        taskId: task.id,
        source: task.source,
        status: "blocked",
        error: "前置任务失败或被阻止，本任务未执行。",
        attempts: 0,
        durationMs: 0
      };
      resultById.set(task.id, result);
      blocked.push(result);
      changed = true;
    }
  }

  return blocked;
}

function dispatchReadyTasks(state: typeof ParallelReadState.State) {
  const resultById = new Map(
    state.results.map((result) => [result.taskId, result])
  );
  const pending = state.tasks.filter((task) => !resultById.has(task.id));
  if (pending.length === 0) {
    return "aggregate_results";
  }

  const ready = pending
    .filter((task) =>
      task.dependsOn.every(
        (dependencyId) =>
          resultById.get(dependencyId)?.status === "succeeded"
      )
    )
    .slice(0, state.maxConcurrency);

  if (ready.length === 0) {
    // 循环依赖已在 validate_plan 拦截；这里是防御性兜底。
    return "aggregate_results";
  }

  // 标准 Send API：同一 Worker Node 接收不同任务状态并在当前 superstep 并行运行。
  return ready.map(
    (task) =>
      new Send(
        "execute_task",
        {
          task,
          completedResults: state.results
        },
        {
          timeout: task.timeoutMs * task.maxAttempts + 2_000
        }
      )
  );
}

function validateTaskGraph(tasks: ScheduledReadTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`动态调度任务 ID 重复：${task.id}`);
    }
    ids.add(task.id);
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (!ids.has(dependencyId)) {
        throw new Error(
          `任务 ${task.id} 引用了不存在的依赖：${dependencyId}`
        );
      }
      if (dependencyId === task.id) {
        throw new Error(`任务 ${task.id} 不能依赖自身。`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) {
      throw new Error("动态调度计划存在循环依赖。");
    }
    if (visited.has(taskId)) {
      return;
    }
    visiting.add(taskId);
    byId.get(taskId)?.dependsOn.forEach(visit);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  tasks.forEach((task) => visit(task.id));
}

async function executeScheduledTask(
  task: ScheduledReadTask,
  completedResults: Map<string, ScheduledReadResult>,
  runtime: ToolMemoryRuntime
): Promise<ScheduledReadResult> {
  const startedAt = Date.now();
  let attempts = 0;
  try {
    const durable = await executeDurableTask(
      runtime,
      `parallel_read:${task.id}`,
      task,
      async () => {
        const resolvedInput = resolveTaskInput(task.input, completedResults);
        if (
          !resolvedInput ||
          typeof resolvedInput !== "object" ||
          Array.isArray(resolvedInput)
        ) {
          throw new Error(`任务 ${task.id} 的 input 必须是对象。`);
        }
        const parsedRequest = ParallelReadRequestSchema.parse({
          source: task.source,
          ...(resolvedInput as Record<string, unknown>)
        });
        let lastError: unknown;
        for (attempts = 1; attempts <= task.maxAttempts; attempts += 1) {
          runtime.signal?.throwIfAborted();
          try {
            const timeoutSignal = AbortSignal.timeout(task.timeoutMs);
            const signal = runtime.signal
              ? AbortSignal.any([runtime.signal, timeoutSignal])
              : timeoutSignal;
            const scopedRuntime = { ...runtime, signal } as ToolMemoryRuntime;
            return await executeRequest(parsedRequest, scopedRuntime);
          } catch (error) {
            lastError = error;
            if (runtime.signal?.aborted || attempts >= task.maxAttempts) {
              throw error;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(250 * 2 ** (attempts - 1), 1_000))
            );
          }
        }
        throw lastError;
      }
    );
    return {
      taskId: task.id,
      source: task.source,
      status: "succeeded",
      data: durable.result,
      attempts: durable.replayed ? 0 : attempts,
      durationMs: Date.now() - startedAt,
      replayed: durable.replayed
    };
  } catch (error) {
    return {
      taskId: task.id,
      source: task.source,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      attempts,
      durationMs: Date.now() - startedAt
    };
  }
}

function resolveTaskInput(
  value: unknown,
  completedResults: Map<string, ScheduledReadResult>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveTaskInput(item, completedResults));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        resolveTaskInput(nested, completedResults)
      ])
    );
  }
  if (typeof value !== "string") {
    return value;
  }

  const exactMatch = value.match(/^\{\{([a-zA-Z][\w-]*)\.([\w.-]+)\}\}$/);
  if (exactMatch) {
    return readResultPath(completedResults, exactMatch[1], exactMatch[2]);
  }

  return value.replace(
    /\{\{([a-zA-Z][\w-]*)\.([\w.-]+)\}\}/g,
    (_match, taskId: string, resultPath: string) =>
      String(readResultPath(completedResults, taskId, resultPath))
  );
}

function readResultPath(
  completedResults: Map<string, ScheduledReadResult>,
  taskId: string,
  resultPath: string
): unknown {
  const result = completedResults.get(taskId);
  if (!result || result.status !== "succeeded") {
    throw new Error(`无法读取未成功任务 ${taskId} 的结果。`);
  }

  let current: unknown = result;
  for (const segment of resultPath.split(".")) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      throw new Error(`任务结果路径不存在：${taskId}.${resultPath}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
