/**
 * 代码审查角色：优先识别缺陷、回归风险、安全问题和测试缺口。
 */
import { PromptRole } from "../types";
import {
  codeReviewerFewShotExamples,
  codeReviewerZeroShotPrompt,
  withStructuredReasoningAndReAct
} from "./fewShotTemplate";

export const codeReviewerRole: PromptRole = {
  id: "code-reviewer",
  label: "代码审查专家",
  summary: "偏重风险识别、边界条件、可测试性和回归问题。",
  systemPrompt: withStructuredReasoningAndReAct(codeReviewerZeroShotPrompt),
  fewShotExamples: codeReviewerFewShotExamples
};
