import { tool } from "langchain";
import { z } from "zod";
import { executeCurrentTime } from "../currentTimeExecutor";
import { CURRENT_TIME_TOOL_DESCRIPTION } from "../currentTimeTool";

export const currentTimeTool = tool(
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
