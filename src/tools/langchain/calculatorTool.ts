/**
 * LangChain Calculator Tool：让 LLM 负责选择运算，让确定性代码负责计算。
 */
import { tool } from "langchain";
import { z } from "zod";
import { executeCalculator } from "../calculatorExecutor";
import { CALCULATOR_TOOL_DESCRIPTION } from "../calculatorTool";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";

export const calculatorTool = tool(
  // 步骤 3：LangChain 已用 Zod 验证参数，再调用确定性 Executor。
  ({ operation, leftOperand, rightOperand }, runtime: ToolMemoryRuntime) => {
    const argumentsValue = { operation, leftOperand, rightOperand };
    const result = executeCalculator(argumentsValue);

    // 步骤 4：Command 写入 toolContextHistory，并生成配对 ToolMessage。
    return writeToolContext(runtime, "calculator", argumentsValue, result);
  },
  {
    // 步骤 1：name 和 description 帮助 LLM 判断何时选择本工具。
    name: "calculator",
    description: CALCULATOR_TOOL_DESCRIPTION,
    // 步骤 2：Zod Schema 约束模型必须生成的调用参数。
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
