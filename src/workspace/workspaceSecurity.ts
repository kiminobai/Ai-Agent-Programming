import fs from "fs";
import path from "path";
import { getThreadById } from "../threads/threadRepository";

const BLOCKED_SEGMENTS = new Set([".git", ".env", "node_modules"]);

export function getThreadWorkspace(threadId: string, userId: string) {
  const thread = getThreadById(threadId, userId);
  if (!thread || thread.mode !== "work" || !thread.workspacePath) {
    throw new Error("当前工作对话没有绑定项目目录，请重新选择工作区。");
  }

  const rootPath = fs.realpathSync.native(thread.workspacePath);
  if (!fs.statSync(rootPath).isDirectory()) {
    throw new Error("当前工作区已经不存在。");
  }

  return {
    rootPath,
    name: thread.workspaceName || path.basename(rootPath)
  };
}

function validateRelativePath(relativePath: string): string {
  const normalized = relativePath.trim().replace(/\\/g, "/") || ".";
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("工具只接受工作区内的相对路径。");
  }

  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) => segment === ".." || BLOCKED_SEGMENTS.has(segment.toLowerCase())
    )
  ) {
    throw new Error("该路径不允许访问。");
  }
  return normalized;
}

export function resolveWorkspacePath(
  rootPath: string,
  relativePath: string
): string {
  const normalized = validateRelativePath(relativePath);
  const candidate = path.resolve(rootPath, normalized);
  const resolvedRoot = fs.realpathSync.native(rootPath);
  const rootPrefix = `${resolvedRoot}${path.sep}`.toLowerCase();
  const candidateKey = candidate.toLowerCase();
  if (candidateKey !== resolvedRoot.toLowerCase() && !candidateKey.startsWith(rootPrefix)) {
    throw new Error("路径超出当前工作区。");
  }

  // 已存在路径和待创建文件的最近父目录都要解析真实路径，防止符号链接跳出工作区。
  let existingAncestor = candidate;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error("无法确认工作区路径边界。");
    }
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync.native(existingAncestor).toLowerCase();
  if (realAncestor !== resolvedRoot.toLowerCase() && !realAncestor.startsWith(rootPrefix)) {
    throw new Error("路径通过链接指向了工作区之外。");
  }
  return candidate;
}

export function assertSafeCommandArguments(args: string[]): void {
  for (const argument of args) {
    if (
      path.isAbsolute(argument) ||
      /[a-zA-Z]:[\\/]/.test(argument) ||
      argument.split(/[\\/]/).includes("..") ||
      /^(?:-C|--git-dir|--work-tree)(?:=|$)/.test(argument)
    ) {
      throw new Error("命令参数不能访问工作区之外的路径。");
    }
  }
}
