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
import {
  listWorkspaceFilesTool,
  readWorkspaceFileTool,
  runWorkspaceCommandTool,
  writeWorkspaceFileTool
} from "./workspaceTools";

export { calculatorTool } from "./calculatorTool";
export { currentTimeTool } from "./currentTimeTool";
export { knowledgeBaseTool } from "./knowledgeBaseTool";
export { recallPreferenceTool } from "./recallPreferenceTool";
export { rememberPreferenceTool } from "./rememberPreferenceTool";
export { uploadedDocumentTool } from "./uploadedDocumentTool";
export { parallelReadTool } from "./parallelReadTool";
export { weatherTool } from "./weatherTool";
export {
  listWorkspaceFilesTool,
  readWorkspaceFileTool,
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
  // Coding Agent 工具：只在绑定了工作区的 work thread 中可成功执行。
  listWorkspaceFilesTool,
  readWorkspaceFileTool,
  writeWorkspaceFileTool,
  runWorkspaceCommandTool
];
