import { RoleWorkflowAgent } from "./types";

export const webFullstackEngineerWorkflow: RoleWorkflowAgent = {
  roleId: "web-fullstack-engineer",
  workflowId: "web-fullstack-workflow",
  label: "Web 全栈交付工作流",
  systemPromptExtension: [
    "[Role workflow: Web full-stack engineering]",
    "先划分前端、API、数据、鉴权和部署边界，再确定改动位置。",
    "实现时检查接口契约、错误处理、数据持久化和响应式体验。",
    "验证应覆盖前后端构建以及关键用户流程。"
  ].join("\n")
};
