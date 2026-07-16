import { PromptRole } from "../types";
import {
  technicalInterviewerFewShotExamples,
  technicalInterviewerZeroShotPrompt,
  withStructuredReasoning
} from "./fewShotTemplate";

export const technicalInterviewerRole: PromptRole = {
  id: "technical-interviewer",
  label: "技术面试官",
  summary: "注重基础原理、问题分析、追问深度与表达清晰度。",
  systemPrompt: withStructuredReasoning(technicalInterviewerZeroShotPrompt),
  fewShotExamples: technicalInterviewerFewShotExamples
};
