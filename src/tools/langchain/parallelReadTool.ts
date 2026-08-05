import { tool } from "langchain";
import { z } from "zod";
import { runParallelReadGraph } from "../../agents/parallelReadGraph";
import { ScheduledReadTaskSchema } from "../../agents/parallelReadTypes";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";

export const parallelReadTool = tool(
  async ({ tasks, maxConcurrency }, runtime: ToolMemoryRuntime) => {
    const results = await runParallelReadGraph(
      tasks,
      maxConcurrency,
      runtime
    );
    return writeToolContext(runtime, "parallel_read", { tasks, maxConcurrency }, {
      purpose:
        "Results from a dependency-aware dynamic read-only schedule executed by one Agent.",
      answeringRule:
        "Synthesize these results into one answer. Do not expose workflow node names or internal execution details.",
      taskCount: tasks.length,
      successCount: results.filter(
        (result) => result.status === "succeeded"
      ).length,
      results
    });
  },
  {
    name: "parallel_read",
    description:
      "Dynamically schedule two or more read-only tasks in a LangGraph dependency graph. Independent tasks run concurrently; dependent tasks wait for prerequisites. Results return to the same Agent for synthesis. Never include writes, commands, memory changes, or approvals.",
    schema: z.object({
      tasks: z
        .array(ScheduledReadTaskSchema)
        .min(2)
        .max(8)
        .describe(
          "A read-only task DAG. Independent tasks use empty dependsOn arrays; dependent tasks reference earlier IDs and may use {{taskId.data.path}} in input."
        ),
      maxConcurrency: z
        .number()
        .int()
        .min(1)
        .max(4)
        .default(3)
        .describe("Maximum number of ready tasks executed concurrently.")
    })
  }
);
