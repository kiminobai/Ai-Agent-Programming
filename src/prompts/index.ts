import { codeReviewerRole } from "./codeReviewer";
import { productManagerRole } from "./productManager";
import { pythonEngineerRole } from "./pythonEngineer";
import { reactExpertRole } from "./reactExpert";
import { technicalInterviewerRole } from "./technicalInterviewer";
import { webFullstackEngineerRole } from "./webFullstackEngineer";
import { PromptRole } from "../types";

export const promptRoles: PromptRole[] = [
  pythonEngineerRole,
  productManagerRole,
  codeReviewerRole,
  webFullstackEngineerRole,
  reactExpertRole,
  technicalInterviewerRole
];

export function getPromptRoleById(roleId: string): PromptRole | undefined {
  return promptRoles.find((role) => role.id === roleId);
}
