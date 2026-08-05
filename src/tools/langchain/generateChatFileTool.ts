import { tool } from "langchain";
import { z } from "zod";
import type { AgentContext } from "../../agents/agentContext";
import { executeDurableTask } from "../../agents/durableTaskExecution";
import { createGeneratedFile } from "../../files/generatedFileStore";
import type { ToolMemoryRuntime } from "../../agents/toolMemoryState";

export const generateChatFileTool = tool(
  async ({ fileName, content }, runtime: ToolMemoryRuntime) => {
    const context = runtime.context as AgentContext;
    const durable = await executeDurableTask(
      runtime,
      "generate_chat_file",
      { fileName, content },
      () =>
        createGeneratedFile({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          fileName,
          content
        })
    );
    return JSON.stringify({
      ok: true,
      fileId: durable.result.fileId,
      fileName: durable.result.fileName,
      fileSize: durable.result.fileSize,
      replayed: durable.replayed
    });
  },
  {
    name: "generate_chat_file",
    description:
      "Create a UTF-8 text-based downloadable file in Chat mode when the user explicitly asks for a file. Supports source code, Markdown, TXT, JSON, CSV, HTML, XML and YAML. Do not use in Work mode.",
    schema: z.object({
      fileName: z.string().min(1).max(120),
      content: z.string().max(2_000_000)
    })
  }
);
