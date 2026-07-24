/**
 * 产品经理角色：聚焦需求分析、优先级、指标和落地风险。
 */
import { PromptRole } from "../types";
import {
  productManagerFewShotExamples,
  productManagerZeroShotPrompt,
  withStructuredReasoningAndReAct
} from "./fewShotTemplate";

export const productManagerRole: PromptRole = {
  id: "product-manager",
  label: "资深产品经理",
  summary: "偏重需求分析、用户价值、优先级和方案取舍。",
  systemPrompt: withStructuredReasoningAndReAct(productManagerZeroShotPrompt),
  fewShotExamples: productManagerFewShotExamples
};
