import path from "node:path";

const BLOCKED_SCOPE_SEGMENTS = new Set([".git", ".env", "node_modules"]);

/**
 * 把用户审批的子 Agent 写入范围规范化为安全相对路径。
 * 这里只做纯字符串校验；实际写入时 workspaceSecurity 还会检查真实路径和符号链接。
 */
export function normalizeWorkspaceScopePath(value: string): string {
  const normalized =
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "") || ".";
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("子 Agent 写入范围只能使用工作区内相对路径。");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === ".." || BLOCKED_SCOPE_SEGMENTS.has(segment.toLowerCase())
    )
  ) {
    throw new Error("子 Agent 写入范围包含禁止访问的路径。");
  }
  return normalized;
}

export function isWorkspaceWritePathAllowed(
  relativePath: string,
  approvedPrefixes: string[]
): boolean {
  const target = normalizeWorkspaceScopePath(relativePath);
  return approvedPrefixes.some((prefix) => {
    const normalizedPrefix = normalizeWorkspaceScopePath(prefix);
    return (
      normalizedPrefix === "." ||
      target === normalizedPrefix ||
      target.startsWith(`${normalizedPrefix}/`)
    );
  });
}

export function workspaceScopesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkspaceScopePath(left);
  const normalizedRight = normalizeWorkspaceScopePath(right);
  return (
    normalizedLeft === "." ||
    normalizedRight === "." ||
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}
