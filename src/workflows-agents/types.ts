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
   * 子 Agent 不直接面向用户。顾问型只读分析；执行型经审批后可在最小授权
   * 路径内修改和验证。最终答案仍由主管统一检查与汇总。
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
  /**
   * 子代理可接收的 Skill 白名单。
   *
   * Skill 还必须已由主管在当前轮激活；白名单本身不会自动加载 Skill，
   * 也不会扩大该子代理的 Tool 权限。
   */
  skillPolicy?: {
    allowedSkills: string[];
  };
  /**
   * 执行型子代理批准后可使用的副作用工具。
   * 运行层还会应用全局安全白名单和用户批准的写入路径。
   */
  executionPolicy?: {
    allowedTools: Array<
      | "write_workspace_file"
      | "replace_workspace_text"
      | "run_workspace_command"
    >;
  };
}
