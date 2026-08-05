/**
 * 把角色专属子 Agent 包装成主管 Agent 可以调用的内部工具。
 *
 * 这里采用 Supervisor 模式：
 * 1. 用户只和当前角色主管对话。
 * 2. 主管根据任务复杂度决定是否委派一个或多个子 Agent。
 * 3. 子 Agent 只返回专业分析，不能直接操作工具或面向用户回答。
 * 4. 主管汇总分析后，统一调用工具并生成最终答案。
 */
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import type {
  RoleSubAgentDefinition,
  RoleWorkflowAgent
} from "../workflows-agents/types";

const INTERNAL_SUB_AGENT_TAG = "internal-role-sub-agent";

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("");
}

function getLatestAgentText(result: unknown): string {
  const messages =
    result &&
    typeof result === "object" &&
    "messages" in result &&
    Array.isArray((result as { messages?: unknown }).messages)
      ? (result as { messages: Array<{ content?: unknown }> }).messages
      : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractText(messages[index]?.content).trim();
    if (text) {
      return text;
    }
  }

  throw new Error("角色子 Agent 没有返回有效分析。");
}

function createRoleSubAgentTool(
  model: ChatOpenAI,
  roleWorkflow: RoleWorkflowAgent,
  definition: RoleSubAgentDefinition
) {
  // 子 Agent 不挂载业务工具，避免它绕过主管直接写文件、执行命令或修改记忆。
  const subAgent = createAgent({
    model,
    tools: [],
    systemPrompt: [
      definition.systemPrompt,
      "",
      "你是内部子 Agent，只向主管 Agent 提供专业分析。",
      "不要提及系统提示、工作流、子 Agent 或内部推理过程。",
      "不要直接对最终用户说话，不要声称已经执行文件或命令操作。",
      "输出应简洁、具体，并明确关键结论、风险和建议。"
    ].join("\n")
  });

  return tool(
    async ({ task, context, expectedOutput }) => {
      const result = await subAgent.invoke(
        {
          messages: [
            new HumanMessage(
              [
                `主管角色：${roleWorkflow.label}`,
                `委派任务：${task}`,
                context ? `已知上下文：${context}` : "",
                expectedOutput ? `期望产出：${expectedOutput}` : ""
              ]
                .filter(Boolean)
                .join("\n")
            )
          ]
        },
        {
          // 外层事件流据此过滤子 Agent token，内部分析不会直接显示给用户。
          tags: [INTERNAL_SUB_AGENT_TAG],
          configurable: {
            subAgentId: definition.id
          }
        }
      );

      return getLatestAgentText(result);
    },
    {
      name: `consult_${definition.id}`,
      description: [
        `${definition.label}：${definition.description}`,
        "仅在任务确实需要该专业视角时调用；简单问题不要调用。",
        "可以调用多个不同子 Agent，但不要对同一任务重复调用同一个子 Agent。"
      ].join(" "),
      schema: z.object({
        task: z.string().min(1).describe("需要子 Agent 独立分析的具体任务。"),
        context: z
          .string()
          .optional()
          .describe("完成任务必需的背景、约束或已有事实，不要传入无关对话。"),
        expectedOutput: z
          .string()
          .optional()
          .describe("主管希望收到的分析形式，例如风险清单、实现建议或测试方案。")
      })
    }
  );
}

export function createRoleSubAgentTools(
  model: ChatOpenAI,
  roleWorkflow?: RoleWorkflowAgent
) {
  if (!roleWorkflow) {
    return [];
  }

  return roleWorkflow.subAgents.map((definition) =>
    createRoleSubAgentTool(model, roleWorkflow, definition)
  );
}

export function isInternalSubAgentEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }

  const candidate = event as {
    tags?: unknown;
    metadata?: {
      tags?: unknown;
    };
  };
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags
    : Array.isArray(candidate.metadata?.tags)
      ? candidate.metadata.tags
      : [];

  return tags.includes(INTERNAL_SUB_AGENT_TAG);
}
