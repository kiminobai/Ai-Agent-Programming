import { tool } from "langchain";
import { z } from "zod";
import { AgentContext } from "../../agents/agentContext";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";
import {
  saveUserPreference,
  THEME_PREFERENCE_KEY,
  UserPreferenceMemory
} from "../../memory/longTermMemory";
import { executeDurableTask } from "../../agents/durableTaskExecution";

export const rememberPreferenceTool = tool(
  async ({ preferenceType, value }, runtime: ToolMemoryRuntime) => {
    // 学习点：工具运行时可以拿到 AgentContext。
    // 这里用 userId 写长期记忆，保证换 thread_id 后偏好仍然存在。
    const context = (runtime.context ?? {}) as AgentContext;
    const memory: UserPreferenceMemory = {
      preferenceType,
      value,
      updatedAt: new Date().toISOString(),
      source: "tool"
    };

    const durable = await executeDurableTask(
      runtime,
      "remember_preference",
      { preferenceType, value },
      () => {
        saveUserPreference(context.userId, memory, context.threadId);
        return {
          saved: true,
          key: THEME_PREFERENCE_KEY,
          memory
        };
      }
    );

    // 学习点：writeToolContext 会把本次工具调用结果写回短期状态。
    // 这样 Agent 下一步回答时能知道“偏好已经保存成功”。
    return writeToolContext(
      runtime,
      "remember_preference",
      { preferenceType, value, userId: context.userId },
      { ...durable.result, replayed: durable.replayed }
    );
  },
  {
    name: "remember_preference",
    description:
      "Save a stable user preference into long-term memory. Use when the user explicitly asks you to remember a preference, such as preferring dark theme.",
    schema: z.object({
      preferenceType: z
        .literal("theme")
        .describe("The kind of preference being saved. Currently only theme is supported."),
      value: z
        .string()
        .min(1)
        .describe("The exact preference value to persist, such as dark theme.")
    })
  }
);
