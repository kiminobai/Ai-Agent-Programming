/**
 * 学习点：这是原生 OpenAI-compatible Tool Calling 使用的 Weather JSON Schema。
 */
export type WeatherUnit = "celsius" | "fahrenheit";

export interface GetWeatherArguments {
  location: string;
  unit: WeatherUnit;
}

export const GET_WEATHER_TOOL_DESCRIPTION =
  "查询指定地点的当前天气。仅用于实时天气，不用于天气预报或历史天气；地点应包含城市，存在歧义时还应包含省份、州或国家。";

export const getWeatherTool = {
  // 学习点：Tool Schema 是给模型看的，不是给用户看的。
  // 为什么这样：模型会根据 name、description、parameters 判断是否该调用天气工具，以及该填哪些参数。
  type: "function",
  name: "get_weather",
  description: GET_WEATHER_TOOL_DESCRIPTION,
  strict: true,
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description:
          "要查询的城市和地区，例如“中国北京”或“Paris, France”。"
      },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description:
          "温度单位：celsius 表示摄氏度，fahrenheit 表示华氏度。"
      }
    },
    required: ["location", "unit"],
    additionalProperties: false
  }
} as const;
