import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { tool } from "langchain";
import { z } from "zod";
import { AgentContext } from "../../agents/agentContext";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";
import {
  assertSafeCommandArguments,
  getThreadWorkspace,
  resolveWorkspacePath
} from "../../workspace/workspaceSecurity";
import { saveWorkspaceActivity } from "../../workspace/workspaceActivityRepository";
import { executeDurableTask } from "../../agents/durableTaskExecution";
import {
  assertWorkspaceVersion,
  ensureWorkspaceTurnSnapshot,
  finalizeWorkspaceTurnSnapshot,
  hashWorkspaceContent,
  resolveWorkspaceTurnConflicts
} from "../../workspace/workspaceTurnSnapshotRepository";
import { isWorkspaceWritePathAllowed } from "../../workspace/workspaceDelegationPolicy";

function getWorkspace(runtime: ToolMemoryRuntime) {
  const context = (runtime.context ?? {}) as AgentContext;
  return getThreadWorkspace(context.threadId, context.userId);
}

function assertWritePathAllowed(
  runtime: ToolMemoryRuntime,
  relativePath: string
): void {
  const context = (runtime.context ?? {}) as AgentContext;
  const prefixes = context.workspaceWritePathPrefixes;
  if (!prefixes) {
    return;
  }

  if (!isWorkspaceWritePathAllowed(relativePath, prefixes)) {
    throw new Error(`子 Agent 未获准写入该路径：${relativePath}`);
  }
}

async function collectFiles(
  rootPath: string,
  directoryPath: string,
  depth: number
): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries.slice(0, 200)) {
    if (
      [".git", ".env", "node_modules", "dist", "data"].includes(entry.name)
    ) {
      continue;
    }
    const fullPath = path.join(directoryPath, entry.name);
    const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, "/");
    results.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
    if (entry.isDirectory() && depth > 0) {
      results.push(...(await collectFiles(rootPath, fullPath, depth - 1)));
    }
  }
  return results.slice(0, 500);
}

export const listWorkspaceFilesTool = tool(
  async ({ directory, depth }, runtime: ToolMemoryRuntime) => {
    runtime.signal?.throwIfAborted();
    const workspace = getWorkspace(runtime);
    const directoryPath = resolveWorkspacePath(workspace.rootPath, directory);
    const files = await collectFiles(workspace.rootPath, directoryPath, depth);
    return writeToolContext(runtime, "list_workspace_files", { directory, depth }, {
      workspace: workspace.name,
      files
    });
  },
  {
    name: "list_workspace_files",
    description:
      "列出当前 Coding Agent 工作区内的文件。用户要求创建或修改代码前，先用它了解项目结构。",
    schema: z.object({
      directory: z.string().default(".").describe("工作区内相对目录"),
      depth: z.number().int().min(0).max(3).default(2)
    })
  }
);

export const readWorkspaceFileTool = tool(
  async ({ filePath }, runtime: ToolMemoryRuntime) => {
    runtime.signal?.throwIfAborted();
    const workspace = getWorkspace(runtime);
    const absolutePath = resolveWorkspacePath(workspace.rootPath, filePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > 1_000_000) {
      throw new Error("只能读取不超过 1MB 的文本文件。");
    }
    const content = await fs.readFile(absolutePath, "utf8");
    return writeToolContext(runtime, "read_workspace_file", { filePath }, {
      filePath,
      contentHash: hashWorkspaceContent(content),
      content
    });
  },
  {
    name: "read_workspace_file",
    description: "读取当前工作区内的文本代码文件。路径必须是相对路径。",
    schema: z.object({
      filePath: z.string().min(1).describe("工作区内相对文件路径")
    })
  }
);

export const writeWorkspaceFileTool = tool(
  async ({ filePath, content, expectedHash }, runtime: ToolMemoryRuntime) => {
    assertWritePathAllowed(runtime, filePath);
    const durable = await executeDurableTask(
      runtime,
      "write_workspace_file",
      { filePath, content, expectedHash },
      async ({ idempotencyKey }) => {
        const workspace = getWorkspace(runtime);
        const absolutePath = resolveWorkspacePath(workspace.rootPath, filePath);
        const previousBuffer = await fs.readFile(absolutePath).catch(() => null);
        const previousContent = previousBuffer?.toString("utf8") ?? "";
        const context = (runtime.context ?? {}) as AgentContext;
        assertWorkspaceVersion({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          filePath,
          expectedHash,
          current: previousBuffer ?? Buffer.alloc(0),
          existed: Boolean(previousBuffer)
        });
        await ensureWorkspaceTurnSnapshot({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          filePath,
          absolutePath
        });
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, "utf8");
        await finalizeWorkspaceTurnSnapshot({
          threadId: context.threadId,
          turnId: context.turnId,
          filePath,
          absolutePath
        });
        resolveWorkspaceTurnConflicts({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          filePath
        });
        const previousLines = previousContent
          ? previousContent.split(/\r?\n/).length
          : 0;
        const nextLines = content ? content.split(/\r?\n/).length : 0;
        saveWorkspaceActivity({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          idempotencyKey,
          activityType: "file_write",
          filePath,
          additions: Math.max(0, nextLines - previousLines),
          deletions: Math.max(0, previousLines - nextLines)
        });
        return {
          filePath,
          bytesWritten: Buffer.byteLength(content, "utf8")
        };
      }
    );
    return writeToolContext(runtime, "write_workspace_file", { filePath }, {
      ...durable.result,
      replayed: durable.replayed
    });
  },
  {
    name: "write_workspace_file",
    description:
      "在当前工作区创建或完整覆盖一个文本文件。该操作会修改本机文件，必须经过用户审批。",
    schema: z.object({
      filePath: z.string().min(1).describe("工作区内相对文件路径"),
      content: z.string().describe("要写入文件的完整内容"),
      expectedHash: z
        .string()
        .describe("read_workspace_file 返回的 contentHash；新文件使用 missing")
    })
  }
);

export const replaceWorkspaceTextTool = tool(
  async ({ filePath, operations, expectedHash }, runtime: ToolMemoryRuntime) => {
    assertWritePathAllowed(runtime, filePath);
    const durable = await executeDurableTask(
      runtime,
      "replace_workspace_text",
      { filePath, operations, expectedHash },
      async ({ idempotencyKey }) => {
        const workspace = getWorkspace(runtime);
        const absolutePath = resolveWorkspacePath(workspace.rootPath, filePath);
        const previousContent = await fs.readFile(absolutePath, "utf8");
        const context = (runtime.context ?? {}) as AgentContext;
        assertWorkspaceVersion({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          filePath,
          expectedHash,
          current: Buffer.from(previousContent, "utf8"),
          existed: true
        });
        let nextContent = previousContent;
        let replacementCount = 0;

        for (const operation of operations) {
          if (!nextContent.includes(operation.find)) {
            // 精确匹配失败就停止，避免 Agent 猜测行号后改错代码。
            throw new Error(
              `文件内容已变化或目标不存在，未执行写入：${operation.find.slice(0, 80)}`
            );
          }
          if (operation.replaceAll) {
            const parts = nextContent.split(operation.find);
            replacementCount += parts.length - 1;
            nextContent = parts.join(operation.replace);
          } else {
            replacementCount += 1;
            nextContent = nextContent.replace(operation.find, operation.replace);
          }
        }

        await ensureWorkspaceTurnSnapshot({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          filePath,
          absolutePath
        });
        await fs.writeFile(absolutePath, nextContent, "utf8");
        await finalizeWorkspaceTurnSnapshot({
          threadId: context.threadId,
          turnId: context.turnId,
          filePath,
          absolutePath
        });
        resolveWorkspaceTurnConflicts({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          filePath
        });
        saveWorkspaceActivity({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          idempotencyKey,
          activityType: "file_write",
          filePath,
          additions: Math.max(
            0,
            nextContent.split(/\r?\n/).length -
              previousContent.split(/\r?\n/).length
          ),
          deletions: Math.max(
            0,
            previousContent.split(/\r?\n/).length -
              nextContent.split(/\r?\n/).length
          )
        });
        return {
          filePath,
          replacementCount,
          bytesWritten: Buffer.byteLength(nextContent, "utf8")
        };
      }
    );
    return writeToolContext(runtime, "replace_workspace_text", {
      filePath,
      operations
    }, {
      ...durable.result,
      replayed: durable.replayed
    });
  },
  {
    name: "replace_workspace_text",
    description:
      "在已读取的工作区文本/代码文件中执行精确替换。仅修改匹配内容，任一原文找不到就完全停止；修改现有文件时优先使用，且必须经过用户审批。",
    schema: z.object({
      filePath: z.string().min(1).describe("工作区内相对文件路径"),
      expectedHash: z
        .string()
        .describe("最近一次 read_workspace_file 返回的 contentHash"),
      operations: z.array(
        z.object({
          find: z.string().min(1).describe("文件中必须存在的精确原文"),
          replace: z.string().describe("替换后的内容"),
          replaceAll: z.boolean().default(false)
        })
      ).min(1).max(50)
    })
  }
);

export const runWorkspaceCommandTool = tool(
  async ({ executable, args }, runtime: ToolMemoryRuntime) => {
    const context = (runtime.context ?? {}) as AgentContext;
    const durable = await executeDurableTask(
      runtime,
      "run_workspace_command",
      { executable, args },
      ({ idempotencyKey }) =>
        executeWorkspaceCommand({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          idempotencyKey,
          executable,
          args,
          signal: runtime.signal
        })
    );
    return writeToolContext(
      runtime,
      "run_workspace_command",
      { executable, args },
      { ...durable.result, replayed: durable.replayed }
    );
  },
  {
    name: "run_workspace_command",
    description:
      "在当前工作区运行受控开发命令。使用程序和参数数组，不支持 shell 管道或重定向，执行前必须审批。",
    schema: z.object({
      executable: z.enum(["npm", "npm.cmd", "npx", "npx.cmd", "node", "git"]),
      args: z.array(z.string()).max(20).default([])
    })
  }
);

const ALLOWED_EXECUTABLES = new Set([
  "npm", "npm.cmd", "npx", "npx.cmd", "node", "git"
]);

export async function executeWorkspaceCommand(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  idempotencyKey?: string;
  executable: string;
  args: string[];
  signal?: AbortSignal;
}) {
  if (!ALLOWED_EXECUTABLES.has(input.executable)) {
    throw new Error("控制台只允许 npm、npx、node 和 git 命令。");
  }
  assertSafeCommandArguments(input.args);
  if (input.executable === "git") {
    assertReadOnlyGitCommand(input.args);
  }
  const workspace = getThreadWorkspace(input.threadId, input.userId);
  const executable =
    process.platform === "win32" && ["npm", "npx"].includes(input.executable)
      ? `${input.executable}.cmd`
      : input.executable;
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(executable, input.args, {
        cwd: workspace.rootPath,
        shell: false,
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout = `${stdout}${chunk}`.slice(-20_000);
      });
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-20_000);
      });
      input.signal?.addEventListener("abort", () => child.kill(), { once: true });
      child.once("error", reject);
      child.once("exit", (code) =>
        resolve({ exitCode: code ?? -1, stdout, stderr })
      );
    }
  );
  saveWorkspaceActivity({
    threadId: input.threadId,
    userId: input.userId,
    turnId: input.turnId,
    idempotencyKey: input.idempotencyKey,
    activityType: "command",
    commandText: [input.executable, ...input.args].join(" "),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr
  });
  return result;
}

function assertReadOnlyGitCommand(args: string[]): void {
  const subcommand = args.find((argument) => !argument.startsWith("-")) || "";
  const allowed = new Set([
    "status",
    "diff",
    "log",
    "show",
    "rev-parse",
    "ls-files",
    "describe"
  ]);
  if (!allowed.has(subcommand)) {
    throw new Error(
      "Agent 控制台只允许只读 Git 命令。暂存、提交、切换和回退必须由用户通过独立 Git 界面操作。"
    );
  }
}
