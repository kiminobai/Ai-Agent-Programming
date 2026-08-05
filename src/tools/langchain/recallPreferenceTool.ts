import { tool } from "langchain";
import { z } from "zod";
import { AgentContext } from "../../agents/agentContext";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";
import {
  getUserPreference,
  THEME_PREFERENCE_KEY
} from "../../memory/longTermMemory";

export const recallPreferenceTool = tool(
  async ({ preferenceType }, runtime: ToolMemoryRuntime) => {
    // 学习点：读取长期记忆时也要从 runtime.context 里拿 userId。
    // 这样不同用户的偏好不会互相串。
    const context = (runtime.context ?? {}) as AgentContext;
    const memory = getUserPreference(
      context.userId,
      preferenceType,
      context.threadId
    );

    // 学习点：工具读到的记忆会写回短期状态，供 Agent 本轮回答使用。
    return writeToolContext(
      runtime,
      "recall_preference",
      { preferenceType, userId: context.userId },
      {
        found: Boolean(memory?.value),
        key: THEME_PREFERENCE_KEY,
        memory
      }
    );
  },
  {
    name: "recall_preference",
    description:
      "Read a user preference from long-term memory. Use when the user asks what preference was remembered before, or asks you to apply a previously saved preference.",
    schema: z.object({
      preferenceType: z
        .literal("theme")
        .describe("The kind of preference being recalled. Currently only theme is supported.")
    })
  }
);
