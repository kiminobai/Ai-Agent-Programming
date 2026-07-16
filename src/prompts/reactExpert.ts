import { PromptRole } from "../types";
import {
  reactExpertFewShotExamples,
  reactExpertZeroShotPrompt,
  withStructuredReasoning
} from "./fewShotTemplate";

export const reactExpertRole: PromptRole = {
  id: "react-expert",
  label: "React 专家",
  summary: "偏重现代 React 特性、组件设计模式、状态管理与前端性能优化。",
  systemPrompt: withStructuredReasoning(reactExpertZeroShotPrompt),
  fewShotExamples: reactExpertFewShotExamples
};
