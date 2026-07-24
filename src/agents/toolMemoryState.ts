/**
 * Tool Agent 的自定义短期状态。
 *
 * messages 由 LangChain Agent 内置管理；这里额外保存结构化工具上下文，
 * 让工具本身能够通过 ToolRuntime 读取，并通过 Command 写回。
 */
import { ToolMessage } from "@langchain/core/messages";
import {
  Command,
  MessagesValue,
  ReducedValue,
  StateSchema
} from "@langchain/langgraph";
import { ToolRuntime } from "langchain";
import { z } from "zod";

export const ToolContextSchema = z.object({
  toolName: z.string(),
  arguments: z.unknown(),
  result: z.unknown(),
  executedAt: z.string()
});

export type ToolContext = z.infer<typeof ToolContextSchema>;

export const ToolMemoryState = new StateSchema({
  // createAgent 需要保留内置消息状态，摘要和 Tool Call 都依赖它。
  messages: MessagesValue,
  // Reducer 允许并行工具在同一个图步骤中安全地追加状态。
  toolContextHistory: new ReducedValue(
    z.array(ToolContextSchema).default(() => []),
    {
      // 初始化时 LangGraph 可能传入完整数组；工具更新时只传入单条记录。
      inputSchema: z.union([
        ToolContextSchema,
        z.array(ToolContextSchema)
      ]),
      reducer: (current, next) =>
        [
          ...current,
          ...(Array.isArray(next) ? next : [next])
        ].slice(-20)
    }
  )
});

export type ToolMemoryRuntime = ToolRuntime<typeof ToolMemoryState.State>;

export function readLastToolContext(
  runtime: ToolMemoryRuntime
): ToolContext | undefined {
  // 工具可在执行前读取同一 thread_id 中最近一次结构化工具状态。
  return runtime.state.toolContextHistory?.at(-1);
}

export function writeToolContext(
  runtime: ToolMemoryRuntime,
  toolName: string,
  argumentsValue: unknown,
  result: unknown
) {
  const previousToolContext = readLastToolContext(runtime);
  const currentToolContext: ToolContext = {
    toolName,
    arguments: argumentsValue,
    result,
    executedAt: new Date().toISOString()
  };
  const content = JSON.stringify({
    data: result,
    previousToolContext: previousToolContext ?? null
  });

  // Command 同时更新自定义 State 和消息历史，保证 Tool Call/Result 配对。
  return new Command({
    update: {
      toolContextHistory: currentToolContext,
      messages: [
        new ToolMessage({
          content,
          tool_call_id: runtime.toolCall?.id ?? ""
        })
      ]
    }
  });
}
