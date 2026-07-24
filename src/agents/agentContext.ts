import { z } from "zod";

// runtime.context 中的 userId 用于长期记忆分区。
export const AgentContextSchema = z.object({
  userId: z.string().min(1)
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
