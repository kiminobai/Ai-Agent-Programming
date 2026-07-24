/**
 * 原生 Tool Calling 的执行路由。
 * 只允许调用白名单中的工具，拒绝模型生成的未知函数名。
 */
import { executeCalculator } from "./calculatorExecutor";
import { executeCurrentTime } from "./currentTimeExecutor";
import { calculatorTool } from "./calculatorTool";
import { currentTimeTool } from "./currentTimeTool";
import { executeGetWeather } from "./weatherExecutor";
import { getWeatherTool } from "./getWeatherTool";

export type SupportedToolName =
  | typeof getWeatherTool.name
  | typeof calculatorTool.name
  | typeof currentTimeTool.name;

const SUPPORTED_TOOL_NAMES = new Set<string>([
  getWeatherTool.name,
  calculatorTool.name,
  currentTimeTool.name
]);

export function isSupportedToolName(
  name: string
): name is SupportedToolName {
  // Type predicate 让调用方在校验后获得精确的工具名称联合类型。
  return SUPPORTED_TOOL_NAMES.has(name);
}

export async function executeTool(
  name: SupportedToolName,
  argumentsValue: unknown
): Promise<unknown> {
  switch (name) {
    case "get_weather":
      return executeGetWeather(argumentsValue);
    case "calculator":
      return executeCalculator(argumentsValue);
    case "current_time":
      return executeCurrentTime(argumentsValue);
  }
}
