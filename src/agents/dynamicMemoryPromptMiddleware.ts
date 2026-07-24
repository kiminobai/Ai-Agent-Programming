/**
 * 基于当前线程 State 和长期记忆，为每次模型调用创建临时动态 System Prompt。
 * 这里不把动态内容写回 messages，因此不会被重复持久化。
 */
import { createMiddleware } from "langchain";
import { z } from "zod";
import { AgentContextSchema } from "./agentContext";
import { ToolContextSchema } from "./toolMemoryState";
import {
  getUserPreference,
  THEME_PREFERENCE_KEY,
  UserPreferenceMemory
} from "../memory/longTermMemory";

const MAX_ARGUMENT_LENGTH = 600;
const MAX_RESULT_LENGTH = 1_200;

function toPromptText(value: unknown, maxLength: number): string {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value) ?? String(value);

  return serialized.length <= maxLength
    ? serialized
    : `${serialized.slice(0, maxLength)}...(truncated)`;
}

export const dynamicMemoryPromptMiddleware = createMiddleware({
  name: "DynamicMemoryPromptMiddleware",
  stateSchema: z.object({
    toolContextHistory: z.array(ToolContextSchema).default(() => [])
  }),
  contextSchema: AgentContextSchema,
  wrapModelCall: async (request, handler) => {
    const { messages, toolContextHistory } = request.state;
    const lastToolContext = toolContextHistory?.at(-1);
    const storedThemePreference = getUserPreference(
      request.runtime.context.userId,
      THEME_PREFERENCE_KEY as "theme"
    );

    const longTermMemoryPrompt = storedThemePreference
      ? [
          "[Long-term memory]",
          `Current userId: ${request.runtime.context.userId}`,
          `Remembered theme preference: ${storedThemePreference.value}`,
          `Last updated at: ${storedThemePreference.updatedAt}`,
          "If the user asks for UI, style, or preference-sensitive output, align with this remembered preference unless the user overrides it."
        ].join("\n")
      : [
          "[Long-term memory]",
          `Current userId: ${request.runtime.context.userId}`,
          "No saved theme preference found for this user yet."
        ].join("\n");

    const shortTermMemoryPrompt = lastToolContext
      ? [
          "[Short-term memory]",
          "Source: toolContextHistory",
          `Current thread has ${messages.length} messages.`,
          `Latest tool: ${lastToolContext.toolName}`,
          `Latest tool arguments: ${toPromptText(lastToolContext.arguments, MAX_ARGUMENT_LENGTH)}`,
          `Latest tool result: ${toPromptText(lastToolContext.result, MAX_RESULT_LENGTH)}`,
          `Executed at: ${lastToolContext.executedAt}`,
          "When the user says 'just now', 'continue', or 'the previous result', use this context first."
        ].join("\n")
      : [
          "[Short-term memory]",
          "Source: messages",
          `Current thread has ${messages.length} messages.`,
          "No structured tool history has been recorded in this thread yet."
        ].join("\n");

    return handler({
      ...request,
      systemMessage: request.systemMessage.concat(
        `\n\n${longTermMemoryPrompt}\n\n${shortTermMemoryPrompt}`
      )
    });
  }
});
