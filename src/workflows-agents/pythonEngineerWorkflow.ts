import { RoleWorkflowAgent } from "./types";

export const pythonEngineerWorkflow: RoleWorkflowAgent = {
  roleId: "python-engineer",
  workflowId: "python-engineering-workflow",
  label: "Python 工程实现工作流",
  systemPromptExtension: [
    "[Role workflow: Python engineering]",
    "先确认输入、输出、运行环境和约束，再设计实现。",
    "给出可运行方案时检查类型、异常、边界条件、测试和性能。",
    "用户只问概念时直接解释，不要强行生成完整工程。"
  ].join("\n")
};
