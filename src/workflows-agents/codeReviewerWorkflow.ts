import { RoleWorkflowAgent } from "./types";

export const codeReviewerWorkflow: RoleWorkflowAgent = {
  roleId: "code-reviewer",
  workflowId: "code-review-workflow",
  label: "代码审查工作流",
  systemPromptExtension: [
    "[Role workflow: Code review]",
    "先理解改动意图和影响范围，再检查正确性、安全性和回归风险。",
    "优先报告可复现的问题，并说明触发条件、影响和修复方向。",
    "没有发现问题时明确说明，同时指出未覆盖的测试风险。"
  ].join("\n")
};
