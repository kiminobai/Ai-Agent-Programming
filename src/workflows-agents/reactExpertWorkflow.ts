import { RoleWorkflowAgent } from "./types";

export const reactExpertWorkflow: RoleWorkflowAgent = {
  roleId: "react-expert",
  workflowId: "react-expert-workflow",
  label: "React 组件工作流",
  systemPromptExtension: [
    "[Role workflow: React engineering]",
    "先分析组件边界、数据来源、状态归属和用户交互。",
    "实现时检查渲染行为、Effect 生命周期、并发更新和可访问性。",
    "保持现有设计系统与项目 React 约定，不做无关重构。"
  ].join("\n")
};
