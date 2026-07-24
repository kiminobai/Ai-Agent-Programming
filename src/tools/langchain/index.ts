/**
 * LangChain 工具注册入口。
 * createAgent 只需导入 langChainTools 即可获得全部第三阶段工具。
 */
import { calculatorTool } from "./calculatorTool";
import { currentTimeTool } from "./currentTimeTool";
import { weatherTool } from "./weatherTool";

export { calculatorTool } from "./calculatorTool";
export { currentTimeTool } from "./currentTimeTool";
export { weatherTool } from "./weatherTool";

export const langChainTools = [
  // 步骤 1：将三个 StructuredTool 放入同一个可用工具列表。
  // 步骤 2：createAgent 绑定列表，模型按描述和 Schema 自动选择。
  // 步骤 3：Tools Node 执行工具，再把结果返回 Model Node。
  weatherTool,
  calculatorTool,
  currentTimeTool
];
