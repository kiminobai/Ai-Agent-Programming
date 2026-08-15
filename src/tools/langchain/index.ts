/**
 * 学习点：这是 LangChain 工具注册入口。
 *
 * createAgent 只需要导入 langChainTools，就能获得当前项目全部工具能力。
 * 模型会根据工具的 name、description 和 schema 自动选择是否调用工具。
 */
import { calculatorTool } from "./calculatorTool";
import { currentTimeTool } from "./currentTimeTool";
import { knowledgeBaseTool } from "./knowledgeBaseTool";
import { recallPreferenceTool } from "./recallPreferenceTool";
import { rememberPreferenceTool } from "./rememberPreferenceTool";
import { uploadedDocumentTool } from "./uploadedDocumentTool";
import { parallelReadTool } from "./parallelReadTool";
import { weatherTool } from "./weatherTool";
import { taskPlanTool } from "./taskPlanTool";
import { generateChatFileTool } from "./generateChatFileTool";
import { editUploadedFileTool } from "./editUploadedFileTool";
import {
  generateExcelWorkbookTool,
  generatePdfFileTool,
  generatePresentationTool,
  generateWordDocumentTool
} from "./officeFileTools";
import {
  listWorkspaceFilesTool,
  readWorkspaceFileTool,
  replaceWorkspaceTextTool,
  runWorkspaceCommandTool,
  writeWorkspaceFileTool
} from "./workspaceTools";
import { remoteSandboxTools } from "./remoteSandboxTools";
import { isRemoteSandboxEnabled } from "../../sandbox/sandboxManager";

export { calculatorTool } from "./calculatorTool";
export { currentTimeTool } from "./currentTimeTool";
export { knowledgeBaseTool } from "./knowledgeBaseTool";
export { recallPreferenceTool } from "./recallPreferenceTool";
export { rememberPreferenceTool } from "./rememberPreferenceTool";
export { uploadedDocumentTool } from "./uploadedDocumentTool";
export { parallelReadTool } from "./parallelReadTool";
export { weatherTool } from "./weatherTool";
export { taskPlanTool } from "./taskPlanTool";
export { generateChatFileTool } from "./generateChatFileTool";
export { editUploadedFileTool } from "./editUploadedFileTool";
export {
  generateExcelWorkbookTool,
  generatePdfFileTool,
  generatePresentationTool,
  generateWordDocumentTool
} from "./officeFileTools";
export {
  listWorkspaceFilesTool,
  readWorkspaceFileTool,
  replaceWorkspaceTextTool,
  runWorkspaceCommandTool,
  writeWorkspaceFileTool
} from "./workspaceTools";

export const langChainTools = [
  // 学习点：基础工具，负责天气、计算、当前时间。
  weatherTool,
  calculatorTool,
  currentTimeTool,
  // 学习点：记忆工具，负责写入/读取长期偏好。
  rememberPreferenceTool,
  recallPreferenceTool,
  // 长期知识库工具：按问题自动选择 Hybrid / GraphRAG，并支持多版本资料。
  knowledgeBaseTool,
  // 学习点：文档工具，按需触发上传文件的 Hybrid RAG 检索。
  uploadedDocumentTool,
  // 单 Agent 公共并行工具：多个独立只读任务由 LangGraph 同时执行并统一汇总。
  parallelReadTool,
  // Work 复杂任务的结构化计划，只记录执行状态，不把内部推理暴露给用户。
  taskPlanTool,
  // Chat 文件交付工具：生成文本类文件并提供持久化下载。
  generateChatFileTool,
  generatePdfFileTool,
  generateWordDocumentTool,
  generateExcelWorkbookTool,
  generatePresentationTool,
  // 原文件编辑工具：绑定上传件并生成有来源、有版本的修改副本。
  editUploadedFileTool,
  // Coding Agent 工具：只在绑定了工作区的 work thread 中可成功执行。
  listWorkspaceFilesTool,
  readWorkspaceFileTool,
  replaceWorkspaceTextTool,
  writeWorkspaceFileTool,
  runWorkspaceCommandTool
];

// 远程执行能力只注入 Work Agent；Chat 对话不会看到这些工具，也不会误触发远程资源。
export function getLangChainTools(mode: "chat" | "work") {
  if (mode !== "work" || !isRemoteSandboxEnabled()) return langChainTools;

  // 开启远程隔离后移除本机写入/命令工具，避免模型绕过 Sandbox。
  // 本机读取仍保留，用于理解项目；最终回写只能走带审批和快照的 apply_sandbox_files。
  const unsafeLocalToolNames = new Set([
    "write_workspace_file",
    "replace_workspace_text",
    "run_workspace_command"
  ]);
  return [
    ...langChainTools.filter((registeredTool) =>
      !unsafeLocalToolNames.has(registeredTool.name)
    ),
    ...remoteSandboxTools
  ];
}
