/**
 * 根据当前线程的完整 State，为每次模型调用创建临时的动态 System Prompt。
 *
 * 这里不把 SystemMessage 写入 messages，因此动态内容不会被持久化和重复累积。
 */
import { createMiddleware } from "langchain";
import { z } from "zod";
import { ToolContextSchema } from "./toolMemoryState";

const MAX_ARGUMENT_LENGTH = 600;
const MAX_RESULT_LENGTH = 1_200;

function toPromptText(value: unknown, maxLength: number): string {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value) ?? String(value);

  return serialized.length <= maxLength
    ? serialized
    : `${serialized.slice(0, maxLength)}...（已截断）`;
}

export const dynamicMemoryPromptMiddleware = createMiddleware({
  name: "DynamicMemoryPromptMiddleware",
  // 中间件只声明自己需要读取的自定义字段，不重复声明内置 messages。
  stateSchema: z.object({
    toolContextHistory: z.array(ToolContextSchema).default(() => [])
  }),
  wrapModelCall: async (request, handler) => {
    // 步骤 1：读取内置对话历史和自定义的结构化工具历史。
    // Agent 已统一注册 ToolMemoryState；这里不重复注册，避免 messages 被二次初始化。
    const { messages, toolContextHistory } = request.state;
    // ReducedValue 在首次工具写入前可能尚未物化，因此初始值按空历史处理。
    const lastToolContext = toolContextHistory?.at(-1);

    // 步骤 2：根据当前状态生成不同提示。没有工具历史时仍可利用消息数量。
    const dynamicPrompt = lastToolContext
      ? [
          "[动态短期记忆上下文]",
          "状态来源：toolContextHistory",
          `当前线程已有 ${messages.length} 条消息。`,
          `最近工具：${lastToolContext.toolName}`,
          `最近工具参数：${toPromptText(lastToolContext.arguments, MAX_ARGUMENT_LENGTH)}`,
          `最近工具结果：${toPromptText(lastToolContext.result, MAX_RESULT_LENGTH)}`,
          `执行时间：${lastToolContext.executedAt}`,
          "用户提到“刚才”“上一个结果”“继续计算”时，优先结合以上状态理解。",
          "以上是历史快照；用户要求最新实时数据时，必须重新调用相应工具。"
        ].join("\n")
      : [
          "[动态短期记忆上下文]",
          "状态来源：messages",
          `当前线程已有 ${messages.length} 条消息。`,
          "当前还没有结构化工具调用历史。",
          "用户请求实时信息或精确计算时，请选择合适工具，不要猜测。"
        ].join("\n");

    // 步骤 3：只扩展本次模型请求，不修改 Checkpointer 中保存的消息历史。
    return handler({
      ...request,
      systemMessage: request.systemMessage.concat(`\n\n${dynamicPrompt}`)
    });
  }
});
