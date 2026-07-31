import { RoleWorkflowAgent } from "./types";

export const productManagerWorkflow: RoleWorkflowAgent = {
  roleId: "product-manager",
  workflowId: "product-management-workflow",
  label: "产品分析工作流",
  systemPromptExtension: [
    "[Role workflow: Product management]",
    "先识别用户、场景、目标和约束，再判断需求是否真实成立。",
    "方案需要说明价值、优先级、范围、指标、风险和验收标准。",
    "信息不足时指出关键假设，不要虚构调研数据。"
  ].join("\n")
};
