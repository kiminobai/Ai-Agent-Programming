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
}
