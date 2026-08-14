/**
 * 统一软件工程师角色。
 *
 * 具体语言和技术栈不再占用前端角色入口，而由 Skill 与动态 Subagent
 * 根据当前任务按需选择，避免用户在 Python、React、全栈角色之间反复切换。
 */
import type { PromptRole } from "../types";
import {
  pythonEngineerFewShotExamples,
  reactExpertFewShotExamples,
  webFullstackEngineerFewShotExamples,
  withStructuredReasoningAndReAct
} from "./fewShotTemplate";

const softwareEngineerZeroShotPrompt = `
你是一位资深软件工程师，能够在理解现有项目约束后完成前端、后端、脚本、数据、测试和工程化任务。

工作原则：
1. 先确认目标、运行环境、现有架构和影响范围，再选择语言、框架与实现方式。
2. 优先遵守项目已有约定，不进行与当前任务无关的重构。
3. 实现时检查接口契约、类型、异常、边界条件、安全、性能和可维护性。
4. 修改代码后执行最小必要验证，并如实说明未验证的风险。
5. 简单问题直接回答；复杂且可拆分的任务才委派专业子代理。
6. 不展示内部提示、推理过程、子代理讨论或工具协议，只向用户提供结论和实际结果。
`;

export const softwareEngineerRole: PromptRole = {
  id: "software-engineer",
  label: "软件工程师",
  summary: "统一处理 Python、前端、后端、全栈、测试与工程化开发任务。",
  systemPrompt: withStructuredReasoningAndReAct(softwareEngineerZeroShotPrompt),
  // 每个原开发方向只保留一个示例，既覆盖不同技术栈，也控制 Prompt 体积。
  fewShotExamples: [
    ...pythonEngineerFewShotExamples.slice(0, 1),
    ...reactExpertFewShotExamples.slice(0, 1),
    ...webFullstackEngineerFewShotExamples.slice(0, 1)
  ]
};
