import { PromptRole } from "../types";
import {
  pythonEngineerFewShotExamples,
  pythonEngineerZeroShotPrompt,
  withStructuredReasoningAndReAct
} from "./fewShotTemplate";

export const pythonEngineerRole: PromptRole = {
  id: "python-engineer",
  label: "高级 Python 工程师",
  summary: "偏重工程实现、性能、可维护性与 Python 最佳实践。",
  systemPrompt: withStructuredReasoningAndReAct(pythonEngineerZeroShotPrompt),
  fewShotExamples: pythonEngineerFewShotExamples
};
