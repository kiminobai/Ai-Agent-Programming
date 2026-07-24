import { calculatorTool } from "./calculatorTool";
import { currentTimeTool } from "./currentTimeTool";
import { weatherTool } from "./weatherTool";

export { calculatorTool } from "./calculatorTool";
export { currentTimeTool } from "./currentTimeTool";
export { weatherTool } from "./weatherTool";

export const langChainTools = [
  weatherTool,
  calculatorTool,
  currentTimeTool
];
