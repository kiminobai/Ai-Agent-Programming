import fs from "fs/promises";
import path from "path";
import { tool } from "langchain";
import { z } from "zod";
import { appConfig } from "../../config";
import type { AgentContext } from "../../agents/agentContext";
import type { ToolMemoryRuntime } from "../../agents/toolMemoryState";
import { writeToolContext } from "../../agents/toolMemoryState";
import { getOrCreateThreadSandbox } from "../../sandbox/sandboxManager";
import { getThreadWorkspace, resolveWorkspacePath } from "../../workspace/workspaceSecurity";
import {
  ensureWorkspaceTurnSnapshot,
  finalizeWorkspaceTurnSnapshot
} from "../../workspace/workspaceTurnSnapshotRepository";
import { saveWorkspaceActivity } from "../../workspace/workspaceActivityRepository";
import { captureWorkspaceFiles } from "./workspaceTools";

const REMOTE_ROOT = "/workspace";

function contextOf(runtime: ToolMemoryRuntime): AgentContext {
  return (runtime.context ?? {}) as AgentContext;
}

function remotePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("Sandbox 文件路径必须是工作区内的安全相对路径。");
  }
  return `${REMOTE_ROOT}/${normalized}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** 把本地项目的安全快照传入远程环境；.env、.git、node_modules、data 等始终排除。 */
export const prepareRemoteSandboxTool = tool(
  async (_input, runtime: ToolMemoryRuntime) => {
    const context = contextOf(runtime);
    const workspace = getThreadWorkspace(context.threadId, context.userId);
    const files = await captureWorkspaceFiles(workspace.rootPath);
    let totalBytes = 0;
    const uploads: Array<[string, Uint8Array]> = [];
    for (const [filePath, content] of files) {
      totalBytes += content.byteLength;
      if (totalBytes > appConfig.sandbox.maxTransferBytes) {
        throw new Error("上传到远程执行环境的项目快照超过安全上限，请缩小工作目录。");
      }
      uploads.push([remotePath(filePath), content]);
    }
    const sandbox = await getOrCreateThreadSandbox(context.threadId, context.userId);
    const results = await sandbox.uploadFiles(uploads);
    const failed = results.filter((item) => item.error);
    if (failed.length) throw new Error(`有 ${failed.length} 个文件未能传入远程执行环境。`);
    return writeToolContext(runtime, "prepare_remote_sandbox", {}, {
      workspace: workspace.name,
      fileCount: uploads.length,
      totalBytes,
      remoteRoot: REMOTE_ROOT
    });
  },
  {
    name: "prepare_remote_sandbox",
    description:
      "为当前 Work 对话准备独立远程执行环境，并上传排除密钥和依赖目录后的工作区快照。首次远程执行前调用，必须由用户审批。",
    schema: z.object({})
  }
);

export const readRemoteSandboxFileTool = tool(
  async ({ filePath }, runtime: ToolMemoryRuntime) => {
    const context = contextOf(runtime);
    const sandbox = await getOrCreateThreadSandbox(context.threadId, context.userId);
    const [result] = await sandbox.downloadFiles([remotePath(filePath)]);
    if (!result || result.error || !result.content) throw new Error("远程文件不存在或不可读取。");
    if (result.content.byteLength > 1_000_000) throw new Error("单次只能读取不超过 1MB 的远程文本文件。");
    return writeToolContext(runtime, "read_sandbox_file", { filePath }, {
      filePath,
      content: new TextDecoder().decode(result.content)
    });
  },
  {
    name: "read_sandbox_file",
    description: "读取当前对话远程 Sandbox 中的文本文件，不读取本机文件。",
    schema: z.object({ filePath: z.string().min(1) })
  }
);

export const writeRemoteSandboxFileTool = tool(
  async ({ filePath, content }, runtime: ToolMemoryRuntime) => {
    const context = contextOf(runtime);
    const sandbox = await getOrCreateThreadSandbox(context.threadId, context.userId);
    const [result] = await sandbox.uploadFiles([
      [remotePath(filePath), new TextEncoder().encode(content)]
    ]);
    if (!result || result.error) throw new Error("远程文件写入失败。");
    return writeToolContext(runtime, "write_sandbox_file", { filePath }, {
      filePath,
      bytesWritten: Buffer.byteLength(content, "utf8")
    });
  },
  {
    name: "write_sandbox_file",
    description:
      "在隔离的远程 Sandbox 中创建或覆盖文件。它不会直接修改用户本机项目；验证完成后再调用 apply_sandbox_files。",
    schema: z.object({ filePath: z.string().min(1), content: z.string() })
  }
);

export const runRemoteSandboxCommandTool = tool(
  async ({ executable, args }, runtime: ToolMemoryRuntime) => {
    runtime.signal?.throwIfAborted();
    const context = contextOf(runtime);
    const sandbox = await getOrCreateThreadSandbox(context.threadId, context.userId);
    const command = [executable, ...args].map(shellQuote).join(" ");
    const result = await sandbox.execute(`cd ${REMOTE_ROOT} && ${command}`, {
      timeout: appConfig.sandbox.commandTimeoutSeconds
    });
    return writeToolContext(runtime, "run_sandbox_command", { executable, args }, {
      exitCode: result.exitCode,
      output: result.output.slice(-20_000),
      truncated: result.truncated
    });
  },
  {
    name: "run_sandbox_command",
    description:
      "在当前对话的远程隔离环境中运行开发命令。命令无法直接访问用户本机或服务端密钥，执行前必须审批。",
    schema: z.object({
      executable: z.enum(["npm", "npx", "node", "python", "python3", "pytest", "git"]),
      args: z.array(z.string().max(500)).max(30).default([])
    })
  }
);

export const applyRemoteSandboxFilesTool = tool(
  async ({ filePaths }, runtime: ToolMemoryRuntime) => {
    const context = contextOf(runtime);
    const workspace = getThreadWorkspace(context.threadId, context.userId);
    const sandbox = await getOrCreateThreadSandbox(context.threadId, context.userId);
    const downloads = await sandbox.downloadFiles(filePaths.map(remotePath));
    const applied: string[] = [];
    for (let index = 0; index < filePaths.length; index += 1) {
      const filePath = filePaths[index];
      const downloaded = downloads[index];
      if (!downloaded || downloaded.error || !downloaded.content) {
        throw new Error(`远程结果文件不可读取：${filePath}`);
      }
      const absolutePath = resolveWorkspacePath(workspace.rootPath, filePath);
      await ensureWorkspaceTurnSnapshot({
        threadId: context.threadId,
        userId: context.userId,
        turnId: context.turnId,
        filePath,
        absolutePath
      });
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, downloaded.content);
      await finalizeWorkspaceTurnSnapshot({
        threadId: context.threadId,
        turnId: context.turnId,
        filePath,
        absolutePath
      });
      saveWorkspaceActivity({
        threadId: context.threadId,
        userId: context.userId,
        turnId: context.turnId,
        activityType: "file_write",
        filePath
      });
      applied.push(filePath);
    }
    return writeToolContext(runtime, "apply_sandbox_files", { filePaths }, { applied });
  },
  {
    name: "apply_sandbox_files",
    description:
      "把已在远程 Sandbox 验证完成的指定文件应用到本机工作区，并创建可回退快照。该操作必须由用户审批。",
    schema: z.object({ filePaths: z.array(z.string().min(1)).min(1).max(50) })
  }
);

export const remoteSandboxTools = [
  prepareRemoteSandboxTool,
  readRemoteSandboxFileTool,
  writeRemoteSandboxFileTool,
  runRemoteSandboxCommandTool,
  applyRemoteSandboxFilesTool
];
