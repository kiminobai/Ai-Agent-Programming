export type CalculatorOperation =
  | "add"
  | "subtract"
  | "multiply"
  | "divide";

export interface CalculatorArguments {
  operation: CalculatorOperation;
  leftOperand: number;
  rightOperand: number;
}

export const CALCULATOR_TOOL_DESCRIPTION =
  "执行两个数字之间的基础算术运算。适用于加、减、乘、除；除法的第二个操作数不能为 0。";

export const calculatorTool = {
  type: "function",
  name: "calculator",
  description: CALCULATOR_TOOL_DESCRIPTION,
  strict: true,
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["add", "subtract", "multiply", "divide"],
        description:
          "运算类型：add 加法、subtract 减法、multiply 乘法、divide 除法。"
      },
      leftOperand: {
        type: "number",
        description: "运算符左侧的数字。"
      },
      rightOperand: {
        type: "number",
        description: "运算符右侧的数字；执行 divide 时不能为 0。"
      }
    },
    required: ["operation", "leftOperand", "rightOperand"],
    additionalProperties: false
  }
} as const;
