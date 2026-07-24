/**
 * Calculator 的确定性执行器。
 * 即使 Schema 开启 strict，也会把模型参数作为不可信输入再次校验。
 */
import {
  CalculatorArguments,
  CalculatorOperation
} from "./calculatorTool";

export interface CalculatorToolResult {
  operation: CalculatorOperation;
  expression: string;
  result: number;
}

const OPERATION_SYMBOLS: Record<CalculatorOperation, string> = {
  // 这些符号只用于可读表达式，不参与实际运算。
  add: "+",
  subtract: "-",
  multiply: "×",
  divide: "÷"
};

function parseArguments(argumentsValue: unknown): CalculatorArguments {
  // 步骤 1：确认参数是对象，不能直接信任 LLM 输出。
  if (!argumentsValue || typeof argumentsValue !== "object") {
    throw new Error("calculator arguments must be an object.");
  }

  // 步骤 2：转成 Partial 后逐字段校验。
  const candidate = argumentsValue as Partial<CalculatorArguments>;
  const validOperations: CalculatorOperation[] = [
    "add",
    "subtract",
    "multiply",
    "divide"
  ];

  // 步骤 3：operation 只能来自四种受支持运算。
  if (
    !candidate.operation ||
    !validOperations.includes(candidate.operation)
  ) {
    throw new Error(
      "calculator operation must be add, subtract, multiply, or divide."
    );
  }

  // 步骤 4：拒绝字符串、NaN、Infinity 等非有限数字。
  if (
    typeof candidate.leftOperand !== "number" ||
    !Number.isFinite(candidate.leftOperand) ||
    typeof candidate.rightOperand !== "number" ||
    !Number.isFinite(candidate.rightOperand)
  ) {
    throw new Error("calculator operands must be finite numbers.");
  }

  // 步骤 5：除法单独阻止除以零。
  if (
    candidate.operation === "divide" &&
    candidate.rightOperand === 0
  ) {
    throw new Error("calculator cannot divide by zero.");
  }

  // 步骤 6：所有检查通过后返回类型安全参数。
  return {
    operation: candidate.operation,
    leftOperand: candidate.leftOperand,
    rightOperand: candidate.rightOperand
  };
}

export function executeCalculator(
  argumentsValue: unknown
): CalculatorToolResult {
  // 步骤 7：取得已校验参数。
  const { operation, leftOperand, rightOperand } =
    parseArguments(argumentsValue);

  // 步骤 8：固定函数表比动态表达式安全，不会引入 eval 注入。
  const resultByOperation: Record<CalculatorOperation, () => number> = {
    add: () => leftOperand + rightOperand,
    subtract: () => leftOperand - rightOperand,
    multiply: () => leftOperand * rightOperand,
    divide: () => leftOperand / rightOperand
  };
  // 步骤 9：执行运算，并将 JavaScript 的 -0 规范化为 0。
  const rawResult = resultByOperation[operation]();
  const result = Object.is(rawResult, -0) ? 0 : rawResult;

  // 步骤 10：结构化结果供 Tool Agent 观察并生成最终回答。
  return {
    operation,
    expression: `${leftOperand} ${OPERATION_SYMBOLS[operation]} ${rightOperand}`,
    result
  };
}
