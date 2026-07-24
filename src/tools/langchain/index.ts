/**
 * LangChain 工具注册入口。
 * createAgent 只需导入 langChainTools 即可获得当前项目全部工具能力。
 */
import { calculatorTool } from "./calculatorTool";
import { currentTimeTool } from "./currentTimeTool";
import { recallPreferenceTool } from "./recallPreferenceTool";
import { rememberPreferenceTool } from "./rememberPreferenceTool";
import { weatherTool } from "./weatherTool";

export { calculatorTool } from "./calculatorTool";
export { currentTimeTool } from "./currentTimeTool";
export { recallPreferenceTool } from "./recallPreferenceTool";
export { rememberPreferenceTool } from "./rememberPreferenceTool";
export { weatherTool } from "./weatherTool";

export const langChainTools = [
  // 模型会根据 name、description 和 schema 自动选择合适工具。
  weatherTool,
  calculatorTool,
  currentTimeTool,
  rememberPreferenceTool,
  recallPreferenceTool
];
