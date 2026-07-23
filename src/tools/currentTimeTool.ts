export interface CurrentTimeArguments {
  timeZone: string;
}

export const CURRENT_TIME_TOOL_DESCRIPTION =
  "查询指定 IANA 时区的当前日期和时间。适用于用户询问某个城市或地区现在几点，不用于日期计算或日程安排。";

export const currentTimeTool = {
  type: "function",
  name: "current_time",
  description: CURRENT_TIME_TOOL_DESCRIPTION,
  strict: true,
  parameters: {
    type: "object",
    properties: {
      timeZone: {
        type: "string",
        description:
          "IANA 时区名称，例如 Asia/Shanghai、Europe/London 或 America/New_York。"
      }
    },
    required: ["timeZone"],
    additionalProperties: false
  }
} as const;
