import { PromptRole } from "../types";
import {
  webFullstackEngineerFewShotExamples,
  webFullstackEngineerZeroShotPrompt,
  withStructuredReasoningAndReAct
} from "./fewShotTemplate";

export const webFullstackEngineerRole: PromptRole = {
  id: "web-fullstack-engineer",
  label: "Web 全栈工程师",
  summary: "具备端到端开发能力，注重前后端协作、系统设计与工程落地。",
  systemPrompt: withStructuredReasoningAndReAct(
    webFullstackEngineerZeroShotPrompt
  ),
  fewShotExamples: webFullstackEngineerFewShotExamples
};
