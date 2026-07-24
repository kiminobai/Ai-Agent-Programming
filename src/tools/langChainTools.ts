import { tool } from "langchain";
import { z } from "zod";
import { executeCalculator } from "./calculatorExecutor";
import {
  CALCULATOR_TOOL_DESCRIPTION,
  CalculatorOperation
} from "./calculatorTool";
import { executeCurrentTime } from "./currentTimeExecutor";
import { CURRENT_TIME_TOOL_DESCRIPTION } from "./currentTimeTool";
import { executeGetWeather } from "./weatherExecutor";
import { GET_WEATHER_TOOL_DESCRIPTION } from "./getWeatherTool";

export const langChainGetWeatherTool = tool(
  async ({ location, unit }) =>
    JSON.stringify(await executeGetWeather({ location, unit })),
  {
    name: "get_weather",
    description: GET_WEATHER_TOOL_DESCRIPTION,
    schema: z.object({
      location: z
        .string()
        .min(1)
        .describe("要查询的城市和地区，例如“中国北京”或“Paris, France”。"),
      unit: z
        .enum(["celsius", "fahrenheit"])
        .describe("温度单位：celsius 表示摄氏度，fahrenheit 表示华氏度。")
    })
  }
);

export const langChainCalculatorTool = tool(
  ({ operation, leftOperand, rightOperand }) =>
    JSON.stringify(
      executeCalculator({
        operation: operation as CalculatorOperation,
        leftOperand,
        rightOperand
      })
    ),
  {
    name: "calculator",
    description: CALCULATOR_TOOL_DESCRIPTION,
    schema: z.object({
      operation: z
        .enum(["add", "subtract", "multiply", "divide"])
        .describe(
          "运算类型：add 加法、subtract 减法、multiply 乘法、divide 除法。"
        ),
      leftOperand: z.number().finite().describe("运算符左侧的数字。"),
      rightOperand: z
        .number()
        .finite()
        .describe("运算符右侧的数字；执行 divide 时不能为 0。")
    })
  }
);

export const langChainCurrentTimeTool = tool(
  ({ timeZone }) => JSON.stringify(executeCurrentTime({ timeZone })),
  {
    name: "current_time",
    description: CURRENT_TIME_TOOL_DESCRIPTION,
    schema: z.object({
      timeZone: z
        .string()
        .min(1)
        .describe(
          "IANA 时区名称，例如 Asia/Shanghai、Europe/London 或 America/New_York。"
        )
    })
  }
);

export const langChainTools = [
  langChainGetWeatherTool,
  langChainCalculatorTool,
  langChainCurrentTimeTool
];
