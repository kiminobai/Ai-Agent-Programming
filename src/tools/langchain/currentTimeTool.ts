/**
 * LangChain Current Time Tool：根据 IANA 时区返回真实系统时间。
 */
import { tool } from "langchain";
import { z } from "zod";
import { executeCurrentTime } from "../currentTimeExecutor";
import { CURRENT_TIME_TOOL_DESCRIPTION } from "../currentTimeTool";

export const currentTimeTool = tool(
  // 步骤 3：执行器使用系统时间，不让 LLM 根据训练知识猜测。
  ({ timeZone }) => JSON.stringify(executeCurrentTime({ timeZone })),
  {
    // 步骤 1：description 告诉模型只在询问“当前时间”时调用。
    name: "current_time",
    description: CURRENT_TIME_TOOL_DESCRIPTION,
    // 步骤 2：要求标准 IANA 时区，Executor 还会进行第二次校验。
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
