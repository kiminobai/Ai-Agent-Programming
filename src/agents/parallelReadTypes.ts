import { z } from "zod";

/**
 * 独立于 Graph 和 Tool 的请求契约。
 *
 * 单独放置可以切断 GraphRAG Provider 与工具注册之间的运行时循环依赖。
 */
export const ParallelReadRequestSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("knowledge_base"),
    task: z.string().min(1),
    knowledgeBaseId: z.string().optional()
  }),
  z.object({
    source: z.literal("uploaded_document"),
    task: z.string().min(1)
  }),
  z.object({
    source: z.literal("weather"),
    location: z.string().min(1),
    unit: z.enum(["celsius", "fahrenheit"])
  }),
  z.object({
    source: z.literal("current_time"),
    timeZone: z.string().min(1)
  }),
  z.object({
    source: z.literal("calculator"),
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    leftOperand: z.number().finite(),
    rightOperand: z.number().finite()
  })
]);

export type ParallelReadRequest = z.infer<typeof ParallelReadRequestSchema>;

export const ScheduledReadTaskSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)
    .describe("本次计划内唯一、稳定的任务 ID。"),
  source: z.enum([
    "knowledge_base",
    "uploaded_document",
    "weather",
    "current_time",
    "calculator"
  ]),
  input: z
    .record(z.string(), z.unknown())
    .describe(
      "对应来源的输入。依赖前置结果时可使用 {{taskId.data.path}} 占位符。"
    ),
  dependsOn: z.array(z.string()).max(8).default([]),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(12_000),
  maxAttempts: z.number().int().min(1).max(3).default(2)
});

export type ScheduledReadTask = z.infer<typeof ScheduledReadTaskSchema>;

export const ScheduledReadResultSchema = z.object({
  taskId: z.string(),
  source: z.string(),
  status: z.enum(["succeeded", "failed", "blocked"]),
  data: z.unknown().optional(),
  error: z.string().optional(),
  attempts: z.number().int(),
  durationMs: z.number().nonnegative(),
  replayed: z.boolean().optional()
});

export type ScheduledReadResult = z.infer<typeof ScheduledReadResultSchema>;
