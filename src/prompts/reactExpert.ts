/**
 * React 专家角色：聚焦组件设计、状态管理、性能和可维护性。
 */
import { PromptRole } from "../types";
import {
  reactExpertFewShotExamples,
  reactExpertZeroShotPrompt,
  withStructuredReasoningAndReAct
} from "./fewShotTemplate";

export const reactExpertRole: PromptRole = {
  id: "react-expert",
  label: "React 专家",
  summary: "偏重现代 React 特性、组件设计模式、状态管理与前端性能优化。",
  systemPrompt: withStructuredReasoningAndReAct(reactExpertZeroShotPrompt),
  fewShotExamples: reactExpertFewShotExamples
};
