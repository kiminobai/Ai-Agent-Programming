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
    const context = (runtime.context ?? {}) as AgentContext;
    const memory = getUserPreference(context.userId, preferenceType);

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
