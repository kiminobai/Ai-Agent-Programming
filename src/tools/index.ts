import { calculatorTool } from "./calculatorTool";
import { currentTimeTool } from "./currentTimeTool";
import { getWeatherTool } from "./getWeatherTool";

export {
  CALCULATOR_TOOL_DESCRIPTION,
  calculatorTool
} from "./calculatorTool";
export type {
  CalculatorArguments,
  CalculatorOperation
} from "./calculatorTool";
export { executeCalculator } from "./calculatorExecutor";
export type { CalculatorToolResult } from "./calculatorExecutor";
export {
  CURRENT_TIME_TOOL_DESCRIPTION,
  currentTimeTool
} from "./currentTimeTool";
export type { CurrentTimeArguments } from "./currentTimeTool";
export { executeCurrentTime } from "./currentTimeExecutor";
export type { CurrentTimeToolResult } from "./currentTimeExecutor";
export {
  GET_WEATHER_TOOL_DESCRIPTION,
  getWeatherTool
} from "./getWeatherTool";
export type {
  GetWeatherArguments,
  WeatherUnit
} from "./getWeatherTool";
export { executeGetWeather } from "./weatherExecutor";
export type { WeatherToolResult } from "./weatherExecutor";
export {
  executeTool,
  isSupportedToolName
} from "./toolExecutor";
export type { SupportedToolName } from "./toolExecutor";

export const toolSchemas = [
  getWeatherTool,
  calculatorTool,
  currentTimeTool
] as const;
