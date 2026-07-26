/**
 * 学习点：这是原生 Tool Calling 的公共导出入口。
 *
 * Schema 会发送给模型，让模型知道工具名称、描述和参数格式。
 * Executor 只在服务端执行，LLM 自己不会真的调用天气 API 或计算器代码。
 */
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
  // 学习点：auto 模式下，模型可以从这三个 Schema 中选择一个或多个工具。
  // 学习点：这里只登记 Schema；真正的执行逻辑在 toolExecutor 里按工具名分发。
  getWeatherTool,
  calculatorTool,
  currentTimeTool
] as const;
