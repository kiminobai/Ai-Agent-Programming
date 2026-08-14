/**
 * 角色 Prompt 注册入口。
 * 新角色需要在这里加入 promptRoles，前端才会显示。
 */
import { codeReviewerRole } from "./codeReviewer";
import { productManagerRole } from "./productManager";
import { softwareEngineerRole } from "./softwareEngineer";
import { technicalInterviewerRole } from "./technicalInterviewer";
import { PromptRole } from "../types";

export const promptRoles: PromptRole[] = [
  softwareEngineerRole,
  productManagerRole,
  codeReviewerRole,
  technicalInterviewerRole
];

export function getPromptRoleById(roleId: string): PromptRole | undefined {
  const normalizedRoleId = [
    "python-engineer",
    "react-expert",
    "web-fullstack-engineer"
  ].includes(roleId)
    ? "software-engineer"
    : roleId;
  return promptRoles.find((role) => role.id === normalizedRoleId);
}
