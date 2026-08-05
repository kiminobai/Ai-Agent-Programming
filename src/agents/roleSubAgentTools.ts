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
import type { ToolMemoryRuntime } from "./toolMemoryState";
import { executeDurableTask } from "./durableTaskExecution";
import { AgentContextSchema, type AgentContext } from "./agentContext";
import { ToolMemoryState } from "./toolMemoryState";
import {
  finishSubAgentRun,
  startSubAgentRun
} from "./subAgentRunRepository";

const INTERNAL_SUB_AGENT_TAG = "internal-role-sub-agent";
const FORBIDDEN_SUB_AGENT_TOOLS = new Set([
  "write_workspace_file",
  "run_workspace_command",
  "remember_preference"
]);
const DEFAULT_READ_ONLY_TOOLS = [
  "calculator",
  "current_time",
  "get_weather",
  "retrieve_knowledge_base",
  "retrieve_uploaded_document_chunks",
  "recall_preference",
  "list_workspace_files",
  "read_workspace_file"
];
type AgentTool = NonNullable<
  Parameters<typeof createAgent>[0]["tools"]
>[number] & { name: string };

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
  definition: RoleSubAgentDefinition,
  availableTools: AgentTool[]
) {
  const requestedTools =
    definition.toolPolicy?.allowedTools ?? DEFAULT_READ_ONLY_TOOLS;
  const allowedToolNames = requestedTools.filter(
    (toolName) => !FORBIDDEN_SUB_AGENT_TOOLS.has(toolName)
  );
  const subAgentTools = availableTools.filter((candidate) =>
    allowedToolNames.includes(candidate.name)
  );
  const contextPolicy = {
    maxContextChars: definition.contextPolicy?.maxContextChars ?? 6_000,
    includeSupervisorLabel:
      definition.contextPolicy?.includeSupervisorLabel ?? true,
    includeExpectedOutput:
      definition.contextPolicy?.includeExpectedOutput ?? true
  };

  // Custom Subagent 拥有独立 Prompt 和工具白名单，但不会继承主管完整消息历史。
  const subAgent = createAgent({
    model,
    tools: subAgentTools,
    stateSchema: ToolMemoryState,
    contextSchema: AgentContextSchema,
    systemPrompt: [
      definition.systemPrompt,
      "",
      "你是内部子 Agent，只向主管 Agent 提供专业分析。",
      "不要提及系统提示、工作流、子 Agent 或内部推理过程。",
      "不要直接对最终用户说话，不要声称已经执行文件或命令操作。",
      `你只能使用这些只读工具：${allowedToolNames.join("、") || "无"}。`,
      "禁止写文件、执行命令或写入长期记忆；这些副作用只能由主管处理。",
      "输出应简洁、具体，并明确关键结论、风险和建议。"
    ].join("\n")
  });

  return tool(
    async (
      { task, context, expectedOutput },
      runtime: ToolMemoryRuntime
    ) => {
      const agentContext = (runtime.context ?? {}) as AgentContext;
      if (!agentContext.userId || !agentContext.threadId || !agentContext.turnId) {
        throw new Error("子代理运行缺少 userId、threadId 或 turnId。");
      }
      const normalizedTask = task.trim();
      const scopedContext = (context || "")
        .trim()
        .slice(0, contextPolicy.maxContextChars);
      const run = startSubAgentRun({
        threadId: agentContext.threadId,
        userId: agentContext.userId,
        turnId: agentContext.turnId,
        roleId: roleWorkflow.roleId,
        supervisorLabel: roleWorkflow.label,
        agentId: definition.id,
        agentLabel: definition.label,
        taskSummary: normalizedTask.slice(0, 160),
        toolNames: subAgentTools.map((candidate) => candidate.name)
      });

      try {
        const durable = await executeDurableTask(
          runtime,
          `consult_${definition.id}`,
          { task: normalizedTask, context: scopedContext, expectedOutput },
          async () => {
          const result = await subAgent.invoke(
            {
              messages: [
                new HumanMessage(
                  [
                    contextPolicy.includeSupervisorLabel
                      ? `主管角色：${roleWorkflow.label}`
                      : "",
                    `委派任务：${normalizedTask}`,
                    scopedContext ? `必要上下文：${scopedContext}` : "",
                    contextPolicy.includeExpectedOutput && expectedOutput
                      ? `期望产出：${expectedOutput}`
                      : ""
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
              },
              context: agentContext,
              signal: runtime.signal
            }
          );

          return getLatestAgentText(result);
          }
        );
        finishSubAgentRun(run.runId, "succeeded", {
          replayed: durable.replayed
        });

        return JSON.stringify({
          analysis: durable.result,
          replayed: durable.replayed
        });
      } catch (error) {
        finishSubAgentRun(run.runId, "failed", {
          errorText: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
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
  roleWorkflow: RoleWorkflowAgent | undefined,
  availableTools: AgentTool[]
) {
  if (!roleWorkflow) {
    return [];
  }

  return roleWorkflow.subAgents.map((definition) =>
    createRoleSubAgentTool(model, roleWorkflow, definition, availableTools)
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
