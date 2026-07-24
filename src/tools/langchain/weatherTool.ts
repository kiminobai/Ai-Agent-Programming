import { tool } from "langchain";
import { z } from "zod";
import { executeGetWeather } from "../weatherExecutor";
import { GET_WEATHER_TOOL_DESCRIPTION } from "../getWeatherTool";

export const weatherTool = tool(
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
