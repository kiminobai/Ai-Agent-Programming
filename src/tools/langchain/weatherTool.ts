/**
 * LangChain Weather Tool：Zod 描述参数，Executor 查询真实 Open-Meteo。
 */
import { tool } from "langchain";
import { z } from "zod";
import { executeGetWeather } from "../weatherExecutor";
import { GET_WEATHER_TOOL_DESCRIPTION } from "../getWeatherTool";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";

export const weatherTool = tool(
  // 步骤 3：Zod 校验成功后，调用真实 Open-Meteo Executor。
  async ({ location, unit }, runtime: ToolMemoryRuntime) => {
    const argumentsValue = { location, unit };
    const result = await executeGetWeather(argumentsValue, runtime.signal);

    // 步骤 4：Command 写入状态，并把结果作为 ToolMessage 回填给模型。
    return writeToolContext(runtime, "get_weather", argumentsValue, result);
  },
  {
    // 步骤 1：描述限定为“当前天气”，防止误用于预报或历史天气。
    name: "get_weather",
    description: GET_WEATHER_TOOL_DESCRIPTION,
    // 步骤 2：地点和温度单位都必须由模型明确提供。
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
