/**
 * 学习点：这是原生 Tool Calling 的执行路由。
 *
 * 模型只负责“提出要调用哪个工具和参数”。
 * 服务端必须检查工具名是否在白名单里，然后才真正执行。
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
  // 学习点：Type predicate 让 TypeScript 知道校验通过后 name 是合法工具名。
  return SUPPORTED_TOOL_NAMES.has(name);
}

export async function executeTool(
  name: SupportedToolName,
  argumentsValue: unknown
): Promise<unknown> {
  // 步骤 1：根据模型给出的工具名分发到真正的执行函数。
  // 步骤 2：执行发生在服务端，不发生在 LLM 内部。
  switch (name) {
    case "get_weather":
      return executeGetWeather(argumentsValue);
    case "calculator":
      return executeCalculator(argumentsValue);
    case "current_time":
      return executeCurrentTime(argumentsValue);
  }
}
