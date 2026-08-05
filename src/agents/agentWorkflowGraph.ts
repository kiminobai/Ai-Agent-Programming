/**
 * 学习点：这是当前聊天 Agent 的 LangGraph 编排层。
 *
 * LangChain 的 createAgent 本身也是一个 LangGraph 子图，负责模型与工具循环。
 * 这里再用一个显式 StateGraph 描述项目级流程，让“输入检查、执行 Agent、
 * 完成收尾”成为清晰的 Node，并用 Edge 固定它们的执行顺序。
 */
import { BaseMessage } from "@langchain/core/messages";
import {
  BaseCheckpointSaver,
  END,
  START,
  StateGraph
} from "@langchain/langgraph";
import { ToolMemoryState } from "./toolMemoryState";

type AgentState = {
  messages: BaseMessage[];
  toolContextHistory: unknown[];
};

// createAgent 的返回类型包含模型、工具、中间件和 Context 的多层泛型。
// 这里是外层图与 Agent 子图的唯一适配边界，因此只保留 Runnable 的 invoke 能力。
export interface AgentSubgraph {
  invoke(
    input: any,
    config?: any
  ): Promise<any>;
}

export interface AgentWorkflowOptions {
  roleId: string;
  workflowId: string;
  checkpointer: BaseCheckpointSaver;
}

function findLatestHumanMessage(messages: BaseMessage[]): BaseMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].getType() === "human") {
      return messages[index];
    }
  }

  return undefined;
}

function hasVisibleContent(message: BaseMessage | undefined): boolean {
  if (!message) {
    return false;
  }

  if (typeof message.content === "string") {
    return Boolean(message.content.trim());
  }

  // 多模态消息的 content 可能是数组；数组非空就交给模型继续处理。
  return Array.isArray(message.content) && message.content.length > 0;
}

export function createAgentWorkflowGraph(
  agent: AgentSubgraph,
  options: AgentWorkflowOptions
) {
  const workflow = new StateGraph(ToolMemoryState)
    .addNode("validate_input", async (state) => {
      // Node 1：只检查输入，下一条 Conditional Edge 决定走执行还是拒绝分支。
      return {};
    })
    .addNode("reject_input", async () => {
      // 非法输入不会进入模型，也不会触发任何工具。
      throw new Error("请输入消息后再发送。");
    })
    .addNode("prepare_role_workflow", async () => {
      // Node 2：确认本轮已经选中具体角色工作流。
      // 角色专属执行规则已由 Provider 放入私有 System Prompt，不会显示给用户。
      if (!options.roleId || !options.workflowId) {
        throw new Error("当前角色没有可用的 Workflow Agent。");
      }
      return {};
    })
    .addNode("run_agent", async (state, config) => {
      // Node 3：复用现有 createAgent 子图。
      // 子图继续负责 Model -> Tool -> Model 循环、短期记忆和 SQLite checkpoint。
      // 不在包含副作用的整节点上自动重试；恢复由 Checkpointer 和任务账本负责。
      return agent.invoke(state, config);
    })
    .addNode("finish", async () => {
      // Node 4：当前只表示一次工作流正常结束。
      // 后续加入审批、重试或人工中止时，可以在这里扩展，不必改模型节点。
      return {};
    })
    // Edge 决定节点的固定执行顺序。
    .addEdge(START, "validate_input")
    .addConditionalEdges(
      "validate_input",
      (state) => {
        const latestHumanMessage = findLatestHumanMessage(state.messages);
        return hasVisibleContent(latestHumanMessage)
          ? "run_agent"
          : "reject_input";
      },
      {
        run_agent: "prepare_role_workflow",
        reject_input: "reject_input"
      }
    )
    .addEdge("reject_input", END)
    .addEdge("prepare_role_workflow", "run_agent")
    .addEdge("run_agent", "finish")
    .addEdge("finish", END);

  // 外层 Workflow 是本轮执行入口，因此由它统一保存消息、工具状态和中断状态。
  // 内层 Agent 子图会继承这个 Checkpointer，刷新时只需读取同一个根状态。
  return workflow.compile({
    checkpointer: options.checkpointer,
    name: options.workflowId
  });
}
