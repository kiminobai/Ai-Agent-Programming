import { PromptRole } from "../types";
import {
  productManagerFewShotExamples,
  productManagerZeroShotPrompt,
  withStructuredReasoning
} from "./fewShotTemplate";

export const productManagerRole: PromptRole = {
  id: "product-manager",
  label: "资深产品经理",
  summary: "偏重需求分析、用户价值、优先级和方案取舍。",
  systemPrompt: withStructuredReasoning(productManagerZeroShotPrompt),
  fewShotExamples: productManagerFewShotExamples
};
