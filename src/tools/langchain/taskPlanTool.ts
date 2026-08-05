import { tool } from "langchain";
import { z } from "zod";
import type { AgentContext } from "../../agents/agentContext";
import { getThreadById } from "../../threads/threadRepository";
import {
  saveTaskPlan,
  type TaskPlanStatus,
  type TaskPlanStepStatus
} from "../../agents/taskPlanRepository";

const stepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled"
]);

export const taskPlanTool = tool(
  async ({ title, status, steps }, runtime) => {
    const context = runtime.context as AgentContext;
    if (!context.threadId || !context.turnId || !context.userId) {
      throw new Error("任务计划缺少 threadId、turnId 或 userId。");
    }
    if (getThreadById(context.threadId, context.userId)?.mode !== "work") {
      throw new Error("任务计划仅用于 Work 模式。");
    }
    const inProgressCount = steps.filter(
      (step) => step.status === "in_progress"
    ).length;
    if (
      (status === "running" && inProgressCount !== 1) ||
      (status !== "running" && inProgressCount !== 0)
    ) {
      throw new Error(
        status === "running"
          ? "执行中的计划必须且只能有一个 in_progress 步骤。"
          : "已结束的计划不能保留 in_progress 步骤。"
      );
    }
    const plan = saveTaskPlan({
      threadId: context.threadId,
      turnId: context.turnId,
      userId: context.userId,
      title,
      status: status as TaskPlanStatus,
      steps: steps.map((step) => ({
        ...step,
        status: step.status as TaskPlanStepStatus
      }))
    });
    return JSON.stringify({
      ok: true,
      status: plan.status,
      completedSteps: plan.steps.filter((step) => step.status === "completed")
        .length,
      totalSteps: plan.steps.length
    });
  },
  {
    name: "update_task_plan",
    description:
      "Create or update the private structured execution plan for a substantial Work task. Send the complete current step list every time. Do not use for simple chat answers.",
    schema: z.object({
      title: z.string().min(1).max(120),
      status: z.enum(["running", "completed", "failed", "cancelled"]),
      steps: z
        .array(
          z.object({
            id: z.string().min(1).max(40),
            title: z.string().min(1).max(160),
            status: stepStatusSchema
          })
        )
        .min(2)
        .max(8)
    })
  }
);
