/**
 * LangChain 工具注册入口。
 *
 * createAgent 只需要导入 langChainTools，就能获得当前项目全部工具能力。
 * 模型会根据工具的 name、description 和 schema 自动选择是否调用工具。
 */
import { calculatorTool } from "./calculatorTool";
import { currentTimeTool } from "./currentTimeTool";
import { recallPreferenceTool } from "./recallPreferenceTool";
import { rememberPreferenceTool } from "./rememberPreferenceTool";
import { uploadedDocumentTool } from "./uploadedDocumentTool";
import { weatherTool } from "./weatherTool";

export { calculatorTool } from "./calculatorTool";
export { currentTimeTool } from "./currentTimeTool";
export { recallPreferenceTool } from "./recallPreferenceTool";
export { rememberPreferenceTool } from "./rememberPreferenceTool";
export { uploadedDocumentTool } from "./uploadedDocumentTool";
export { weatherTool } from "./weatherTool";

export const langChainTools = [
  // 基础工具：天气、计算器、当前时间。
  weatherTool,
  calculatorTool,
  currentTimeTool,
  // 记忆工具：写入/读取长期偏好。
  rememberPreferenceTool,
  recallPreferenceTool,
  // 文档工具：按需触发上传文件的 Hybrid RAG 检索。
  uploadedDocumentTool
];
