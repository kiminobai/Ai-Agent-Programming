/**
 * 学习点：Skill 中间件位于模型调用之前。
 *
 * 它根据本轮用户输入选择技能，只追加到临时 System Message，
 * 不写入聊天记录，也不会让用户刷新后看到内部技能正文。
 */
import { createMiddleware } from "langchain";
import { AgentContextSchema } from "../agents/agentContext";
import { getUploadedDocument } from "../rag/uploadedDocumentStore";
import { getThreadById } from "../threads/threadRepository";
import {
  formatSkillsForSystemPrompt,
  selectAgentSkills
} from "./skillRegistry";

function getLatestUserText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      _getType?: () => string;
      content?: unknown;
    };
    if (message?._getType?.() !== "human") {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof part.text === "string"
          ) {
            return part.text;
          }
          return "";
        })
        .join("\n");
    }
  }
  return "";
}

export function createSkillPromptMiddleware(roleId?: string) {
  return createMiddleware({
    name: "SkillPromptMiddleware",
    contextSchema: AgentContextSchema,
    wrapModelCall: async (request, handler) => {
      const { userId, threadId } = request.runtime.context;
      const thread = getThreadById(threadId, userId);
      const skills = selectAgentSkills({
        userMessage: getLatestUserText(request.state.messages),
        roleId,
        mode: thread?.mode === "work" ? "work" : "chat",
        hasUploadedDocument: Boolean(getUploadedDocument(threadId))
      });
      const skillPrompt = formatSkillsForSystemPrompt(skills);

      if (!skillPrompt) {
        return handler(request);
      }

      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(`\n\n${skillPrompt}`)
      });
    }
  });
}
