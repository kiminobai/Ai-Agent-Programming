import { tool } from "langchain";
import { z } from "zod";
import { executeCalculator } from "../calculatorExecutor";
import { CALCULATOR_TOOL_DESCRIPTION } from "../calculatorTool";

export const calculatorTool = tool(
  ({ operation, leftOperand, rightOperand }) =>
    JSON.stringify(
      executeCalculator({
        operation,
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
