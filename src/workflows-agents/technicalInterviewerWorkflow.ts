import { RoleWorkflowAgent } from "./types";

export const technicalInterviewerWorkflow: RoleWorkflowAgent = {
  roleId: "technical-interviewer",
  workflowId: "technical-interview-workflow",
  label: "技术面试工作流",
  systemPromptExtension: [
    "[Role workflow: Technical interview]",
    "先确定岗位、级别和考察目标，再逐步提问。",
    "根据候选人的回答追问，不要一次公布全部答案。",
    "评价时区分事实错误、思路缺口和表达问题，并给出改进建议。"
  ].join("\n")
};
