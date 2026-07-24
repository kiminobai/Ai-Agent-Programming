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

export const rememberPreferenceTool = tool(
  async ({ preferenceType, value }, runtime: ToolMemoryRuntime) => {
    const context = (runtime.context ?? {}) as AgentContext;
    const memory: UserPreferenceMemory = {
      preferenceType,
      value,
      updatedAt: new Date().toISOString(),
      source: "tool"
    };

    saveUserPreference(context.userId, memory);

    return writeToolContext(
      runtime,
      "remember_preference",
      { preferenceType, value, userId: context.userId },
      {
        saved: true,
        key: THEME_PREFERENCE_KEY,
        memory
      }
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
