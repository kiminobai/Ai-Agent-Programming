import fs from "node:fs";
import path from "node:path";

const THREAD_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

function requireSafeThreadId(threadId: string): string {
  const normalized = threadId.trim();
  if (!THREAD_ID_PATTERN.test(normalized)) {
    throw new Error("无效的对话标识。");
  }
  return normalized;
}

export function getExtensionsRoot(): string {
  return path.resolve(
    process.env.KIMIBAI_EXTENSIONS_ROOT || path.join(process.cwd(), "data", "extensions")
  );
}

// 每个对话拥有独立扩展目录，避免一个对话安装的能力泄漏到其他 Agent。
export function getThreadExtensionsRoot(threadId: string): string {
  return path.join(getExtensionsRoot(), "threads", requireSafeThreadId(threadId));
}

export function getThreadSkillsRoot(threadId: string): string {
  return path.join(getThreadExtensionsRoot(threadId), "skills");
}

export function getThreadMcpConfigPath(threadId: string): string {
  return path.join(getThreadExtensionsRoot(threadId), "mcp.json");
}

export function deleteThreadExtensions(threadId: string): void {
  fs.rmSync(getThreadExtensionsRoot(threadId), { recursive: true, force: true });
}
