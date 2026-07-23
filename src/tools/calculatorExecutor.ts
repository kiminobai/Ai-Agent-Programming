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
  add: "+",
  subtract: "-",
  multiply: "×",
  divide: "÷"
};

function parseArguments(argumentsValue: unknown): CalculatorArguments {
  if (!argumentsValue || typeof argumentsValue !== "object") {
    throw new Error("calculator arguments must be an object.");
  }

  const candidate = argumentsValue as Partial<CalculatorArguments>;
  const validOperations: CalculatorOperation[] = [
    "add",
    "subtract",
    "multiply",
    "divide"
  ];

  if (
    !candidate.operation ||
    !validOperations.includes(candidate.operation)
  ) {
    throw new Error(
      "calculator operation must be add, subtract, multiply, or divide."
    );
  }

  if (
    typeof candidate.leftOperand !== "number" ||
    !Number.isFinite(candidate.leftOperand) ||
    typeof candidate.rightOperand !== "number" ||
    !Number.isFinite(candidate.rightOperand)
  ) {
    throw new Error("calculator operands must be finite numbers.");
  }

  if (
    candidate.operation === "divide" &&
    candidate.rightOperand === 0
  ) {
    throw new Error("calculator cannot divide by zero.");
  }

  return {
    operation: candidate.operation,
    leftOperand: candidate.leftOperand,
    rightOperand: candidate.rightOperand
  };
}

export function executeCalculator(
  argumentsValue: unknown
): CalculatorToolResult {
  const { operation, leftOperand, rightOperand } =
    parseArguments(argumentsValue);

  const resultByOperation: Record<CalculatorOperation, () => number> = {
    add: () => leftOperand + rightOperand,
    subtract: () => leftOperand - rightOperand,
    multiply: () => leftOperand * rightOperand,
    divide: () => leftOperand / rightOperand
  };
  const rawResult = resultByOperation[operation]();
  const result = Object.is(rawResult, -0) ? 0 : rawResult;

  return {
    operation,
    expression: `${leftOperand} ${OPERATION_SYMBOLS[operation]} ${rightOperand}`,
    result
  };
}
