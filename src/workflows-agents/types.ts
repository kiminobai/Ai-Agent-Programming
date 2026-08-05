/**
 * 学习点：RoleWorkflowAgent 描述“这个角色如何完成任务”。
 *
 * PromptRole 决定角色是谁；RoleWorkflowAgent 决定收到任务后重点检查什么、
 * 按什么顺序组织结果。模型、Tools、Memory 和 Streaming 仍由公共 Agent 负责。
 */
export interface RoleWorkflowAgent {
  roleId: string;
  workflowId: string;
  label: string;
  systemPromptExtension: string;
  /**
   * 当前角色主管可以按需委派的专职子 Agent。
   *
   * 子 Agent 只负责分析并把结果返回主管，不直接面向用户，也不直接调用
   * 工作区写入等高风险工具。最终答案和实际工具操作仍由主管统一负责。
   */
  subAgents: RoleSubAgentDefinition[];
}

export interface RoleSubAgentDefinition {
  id: string;
  label: string;
  description: string;
  systemPrompt: string;
  /**
   * 子代理只接收完成委派任务所需的最小上下文，不继承整个对话历史。
   * maxContextChars 是最后一道容量保护，避免主管把无关长文本全部复制进去。
   */
  contextPolicy?: {
    maxContextChars: number;
    includeSupervisorLabel: boolean;
    includeExpectedOutput: boolean;
  };
  /**
   * 子代理工具采用显式白名单。高风险工具即使误写进白名单也会被运行层拦截。
   * 空数组表示纯分析子代理，不允许调用任何 Tool。
   */
  toolPolicy?: {
    allowedTools: string[];
  };
}
