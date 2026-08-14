import { z } from "zod";

/**
 * runtime.context 由每次 Agent 调用时注入。
 *
 * - userId: 长期记忆分区键
 * - threadId: 当前对话线程键，上传文档工具会据此读取当前线程附件
 */
export const AgentContextSchema = z.object({
  userId: z.string().min(1),
  threadId: z.string().min(1),
  // 每次用户提交使用独立 turnId，把工具操作绑定到对应回复。
  turnId: z.string().optional(),
  // 模型中间件用这两个字段按供应商和模型分别执行 RPM/TPM 与成本预算。
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  // 用户选择的资源档位决定单轮输出预算；服务端硬限额始终优先。
  usageProfile: z.enum(["economy", "balanced", "performance"]).optional(),
  // 执行型子 Agent 的写入能力范围。主管 Agent 不设置此字段。
  workspaceWritePathPrefixes: z.array(z.string().min(1)).max(20).optional()
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
