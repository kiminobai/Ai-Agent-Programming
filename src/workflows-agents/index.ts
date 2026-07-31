/**
 * 角色 Workflow Agent 注册入口。
 *
 * 新增角色时，需要在 prompts 注册角色，并在这里注册对应工作流。
 */
import { promptRoles } from "../prompts";
import { codeReviewerWorkflow } from "./codeReviewerWorkflow";
import { productManagerWorkflow } from "./productManagerWorkflow";
import { pythonEngineerWorkflow } from "./pythonEngineerWorkflow";
import { reactExpertWorkflow } from "./reactExpertWorkflow";
import { technicalInterviewerWorkflow } from "./technicalInterviewerWorkflow";
import { RoleWorkflowAgent } from "./types";
import { webFullstackEngineerWorkflow } from "./webFullstackEngineerWorkflow";

export const roleWorkflowAgents: RoleWorkflowAgent[] = [
  pythonEngineerWorkflow,
  productManagerWorkflow,
  codeReviewerWorkflow,
  webFullstackEngineerWorkflow,
  reactExpertWorkflow,
  technicalInterviewerWorkflow
];

export function getRoleWorkflowAgent(
  roleId: string
): RoleWorkflowAgent | undefined {
  return roleWorkflowAgents.find((workflow) => workflow.roleId === roleId);
}

export function findRoleWorkflowBySystemPrompt(
  systemPrompt: string
): RoleWorkflowAgent | undefined {
  // Provider 现有接口传入的是 System Prompt。
  // 通过 Prompt 注册表反查 roleId，可以接入角色工作流而不用修改前端请求协议。
  const role = promptRoles.find((candidate) => candidate.systemPrompt === systemPrompt);
  return role ? getRoleWorkflowAgent(role.id) : undefined;
}

export type { RoleWorkflowAgent } from "./types";
