import type { RoleWorkflowAgent } from "./types";

const engineeringSkills = [
  "coding",
  "python-engineering",
  "react-engineering",
  "web-fullstack-engineering",
  "secure-code-review",
  "mcp-integration"
];

/**
 * 软件工程主管按任务动态选择专业子代理。
 * 子代理不是前端角色，也不会创建独立对话；它们只在当前主任务内存在。
 */
export const softwareEngineerWorkflow: RoleWorkflowAgent = {
  roleId: "software-engineer",
  workflowId: "software-engineering-workflow",
  label: "软件工程交付工作流",
  systemPromptExtension: [
    "[Role workflow: Software engineering]",
    "先检查项目结构、技术栈、输入输出和约束，再确定改动范围。",
    "根据实际任务选择 Python、前端、后端、架构或测试能力，不预设固定语言。",
    "互不依赖的复杂子任务可以动态并行委派；存在依赖或文件冲突时保持串行。",
    "最终由主管验证、去重并汇总，不能把内部子代理讨论直接展示给用户。"
  ].join("\n"),
  subAgents: [
    {
      id: "software_architect",
      label: "软件架构子 Agent",
      description: "分析模块边界、数据流、接口、依赖和技术权衡。",
      systemPrompt: "你是软件架构专家，聚焦现有项目边界、接口、依赖、数据流、演进成本和风险。",
      skillPolicy: { allowedSkills: engineeringSkills }
    },
    {
      id: "python_engineer",
      label: "Python 工程子 Agent",
      description: "处理 Python 实现、类型、异步、性能、测试和工程环境。",
      systemPrompt: "你是 Python 工程专家，提供符合现有项目约定的实现，并检查类型、异常、边界、性能和测试。",
      skillPolicy: { allowedSkills: engineeringSkills }
    },
    {
      id: "frontend_engineer",
      label: "前端工程子 Agent",
      description: "处理 React、组件、状态、交互、性能、响应式和可访问性。",
      systemPrompt: "你是现代前端工程专家，遵守现有设计系统，检查组件边界、状态、交互、渲染性能和可访问性。",
      skillPolicy: { allowedSkills: engineeringSkills }
    },
    {
      id: "backend_engineer",
      label: "后端与数据子 Agent",
      description: "处理 API、数据模型、鉴权、事务、错误处理和持久化。",
      systemPrompt: "你是后端与数据工程专家，聚焦 API 契约、数据一致性、鉴权、安全、错误处理和迁移风险。",
      skillPolicy: { allowedSkills: engineeringSkills }
    },
    {
      id: "quality_engineer",
      label: "测试与质量子 Agent",
      description: "设计测试、复现缺陷并检查构建、回归、失败路径和交付风险。",
      systemPrompt: "你是测试与质量专家，从用户行为和系统边界设计最小有效验证，覆盖回归、异步、失败路径和构建风险。",
      skillPolicy: { allowedSkills: engineeringSkills }
    }
  ]
};
