import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { createTwoFilesPatch } from "diff";
import { getDatabaseForThread } from "../db/sqlite";
import { getWorkTaskDirectory } from "./localWorkStorage";
import {
  getThreadWorkspace,
  resolveWorkspacePath
} from "./workspaceSecurity";
import { recordAgentEvent } from "../agents/agentTelemetryRepository";

export type WorkspaceTurnDiff = {
  snapshotId: string;
  turnId: string;
  filePath: string;
  status: "active" | "rolled_back";
  additions: number;
  deletions: number;
  patch: string;
  changedAfterSnapshot: boolean;
};

export type WorkspaceConflictType =
  | "write_changed"
  | "rollback_changed"
  | "rollback_failed";

export type WorkspaceTurnConflict = {
  conflictId: string;
  turnId: string;
  filePath: string;
  conflictType: WorkspaceConflictType;
  expectedHash?: string;
  actualHash?: string;
  status: "unresolved" | "resolved";
  message: string;
  createdAt: string;
};

type SnapshotRow = {
  snapshot_id: string;
  thread_id: string;
  user_id: string;
  turn_id: string;
  file_path: string;
  snapshot_key: string | null;
  existed_before: number;
  before_hash: string | null;
  after_hash: string | null;
  status: "active" | "rolled_back";
};

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function hashWorkspaceContent(content: Buffer | string): string {
  return hashBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
}

export function saveWorkspaceTurnConflict(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  filePath: string;
  conflictType: WorkspaceConflictType;
  expectedHash?: string | null;
  actualHash?: string | null;
  message: string;
}): void {
  if (!input.turnId) return;
  getDatabaseForThread(input.threadId).prepare(`
    INSERT INTO workspace_turn_conflicts (
      conflict_id, thread_id, user_id, turn_id, file_path, conflict_type,
      expected_hash, actual_hash, status, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?, ?)
  `).run(
    crypto.randomUUID(),
    input.threadId,
    input.userId,
    input.turnId,
    input.filePath,
    input.conflictType,
    input.expectedHash ?? null,
    input.actualHash ?? null,
    input.message,
    new Date().toISOString()
  );
  recordAgentEvent({
    threadId: input.threadId,
    userId: input.userId,
    turnId: input.turnId,
    eventType: "workspace_conflict",
    status: "detected",
    metadata: { filePath: input.filePath, conflictType: input.conflictType }
  });
}

export function resolveWorkspaceTurnConflicts(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  filePath?: string;
}): void {
  if (!input.turnId) return;
  const fileClause = input.filePath ? " AND file_path = ?" : "";
  const parameters = [
    new Date().toISOString(),
    input.threadId,
    input.userId,
    input.turnId,
    ...(input.filePath ? [input.filePath] : [])
  ];
  getDatabaseForThread(input.threadId).prepare(`
    UPDATE workspace_turn_conflicts
    SET status = 'resolved', resolved_at = ?
    WHERE thread_id = ? AND user_id = ? AND turn_id = ?
      AND status = 'unresolved'${fileClause}
  `).run(...parameters);
}

export function listWorkspaceTurnConflicts(
  threadId: string,
  userId: string,
  turnId: string
): WorkspaceTurnConflict[] {
  return getDatabaseForThread(threadId).prepare(`
    SELECT
      conflict_id AS conflictId,
      turn_id AS turnId,
      file_path AS filePath,
      conflict_type AS conflictType,
      expected_hash AS expectedHash,
      actual_hash AS actualHash,
      status,
      message,
      created_at AS createdAt
    FROM workspace_turn_conflicts
    WHERE thread_id = ? AND user_id = ? AND turn_id = ?
    ORDER BY created_at ASC
  `).all(threadId, userId, turnId) as WorkspaceTurnConflict[];
}

export function listWorkspaceConflicts(
  threadId: string,
  userId: string
): WorkspaceTurnConflict[] {
  return getDatabaseForThread(threadId).prepare(`
    SELECT
      conflict_id AS conflictId,
      turn_id AS turnId,
      file_path AS filePath,
      conflict_type AS conflictType,
      expected_hash AS expectedHash,
      actual_hash AS actualHash,
      status,
      message,
      created_at AS createdAt
    FROM workspace_turn_conflicts
    WHERE thread_id = ? AND user_id = ?
    ORDER BY created_at ASC
  `).all(threadId, userId) as WorkspaceTurnConflict[];
}

export function resolveWorkspaceConflict(input: {
  threadId: string;
  userId: string;
  conflictId: string;
}): boolean {
  const result = getDatabaseForThread(input.threadId).prepare(`
    UPDATE workspace_turn_conflicts
    SET status = 'resolved', resolved_at = ?
    WHERE conflict_id = ? AND thread_id = ? AND user_id = ?
      AND status = 'unresolved'
  `).run(
    new Date().toISOString(),
    input.conflictId,
    input.threadId,
    input.userId
  );
  return result.changes > 0;
}

/**
 * 学习点：expectedHash 是读取文件时取得的版本令牌。
 * 写入前再次比较，能避免审批等待期间用户修改的内容被 Agent 静默覆盖。
 */
export function assertWorkspaceVersion(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  filePath: string;
  expectedHash?: string;
  current: Buffer;
  existed: boolean;
}): void {
  if (!input.expectedHash) {
    throw new Error(`缺少 ${input.filePath} 的读取版本，请重新读取文件后再修改。`);
  }
  const actualHash = input.existed ? hashBuffer(input.current) : "missing";
  if (actualHash === input.expectedHash) return;
  const message = `${input.filePath} 在读取后发生了变化，已停止写入以保护最新内容。请重新读取并基于新版本修改。`;
  saveWorkspaceTurnConflict({
    threadId: input.threadId,
    userId: input.userId,
    turnId: input.turnId,
    filePath: input.filePath,
    conflictType: "write_changed",
    expectedHash: input.expectedHash,
    actualHash,
    message
  });
  throw new Error(message);
}

function resolveSnapshotPath(threadId: string, snapshotKey: string): string {
  const root = getWorkTaskDirectory(threadId, "snapshots");
  const absolutePath = path.resolve(root, snapshotKey);
  const prefix = `${path.resolve(root)}${path.sep}`.toLowerCase();
  if (!absolutePath.toLowerCase().startsWith(prefix)) {
    throw new Error("快照路径超出任务目录。");
  }
  return absolutePath;
}

export async function ensureWorkspaceTurnSnapshot(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  filePath: string;
  absolutePath: string;
}): Promise<void> {
  if (!input.turnId) {
    throw new Error("当前文件修改缺少 turnId，无法创建安全回退点。");
  }
  const database = getDatabaseForThread(input.threadId);
  const existing = database.prepare(`
    SELECT snapshot_id
    FROM workspace_turn_snapshots
    WHERE thread_id = ? AND turn_id = ? AND file_path = ?
  `).get(input.threadId, input.turnId, input.filePath);
  if (existing) {
    return;
  }

  const before = await fs.readFile(input.absolutePath).catch(() => null);
  await ensureWorkspaceTurnSnapshotFromBuffer({
    threadId: input.threadId,
    userId: input.userId,
    turnId: input.turnId,
    filePath: input.filePath,
    before
  });
}

export async function ensureWorkspaceTurnSnapshotFromBuffer(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  filePath: string;
  before: Buffer | null;
}): Promise<void> {
  if (!input.turnId) {
    throw new Error("当前文件修改缺少 turnId，无法创建安全回退点。");
  }
  const database = getDatabaseForThread(input.threadId);
  const existing = database.prepare(`
    SELECT snapshot_id
    FROM workspace_turn_snapshots
    WHERE thread_id = ? AND turn_id = ? AND file_path = ?
  `).get(input.threadId, input.turnId, input.filePath);
  if (existing) return;

  const before = input.before;
  const snapshotId = crypto.randomUUID();
  const snapshotKey = before ? `${snapshotId}.snapshot` : null;
  if (before && snapshotKey) {
    const snapshotPath = resolveSnapshotPath(input.threadId, snapshotKey);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, before);
  }
  database.prepare(`
    INSERT INTO workspace_turn_snapshots (
      snapshot_id, thread_id, user_id, turn_id, file_path, snapshot_key,
      existed_before, before_hash, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    snapshotId,
    input.threadId,
    input.userId,
    input.turnId,
    input.filePath,
    snapshotKey,
    before ? 1 : 0,
    before ? hashBuffer(before) : null,
    new Date().toISOString()
  );
}

export async function finalizeWorkspaceTurnSnapshot(input: {
  threadId: string;
  turnId?: string;
  filePath: string;
  absolutePath: string;
}): Promise<void> {
  if (!input.turnId) {
    return;
  }
  // 命令可能删除文件；空 Buffer 是“文件不存在”的稳定 after 版本令牌。
  const after = await fs.readFile(input.absolutePath).catch(() => Buffer.alloc(0));
  getDatabaseForThread(input.threadId).prepare(`
    UPDATE workspace_turn_snapshots
    SET after_hash = ?
    WHERE thread_id = ? AND turn_id = ? AND file_path = ?
  `).run(hashBuffer(after), input.threadId, input.turnId, input.filePath);
}

export async function listWorkspaceTurnDiffs(
  threadId: string,
  userId: string,
  turnId: string
): Promise<WorkspaceTurnDiff[]> {
  const rows = getDatabaseForThread(threadId).prepare(`
    SELECT *
    FROM workspace_turn_snapshots
    WHERE thread_id = ? AND user_id = ? AND turn_id = ?
    ORDER BY created_at ASC
  `).all(threadId, userId, turnId) as SnapshotRow[];
  const workspace = getThreadWorkspace(threadId, userId);

  return Promise.all(rows.map(async (row) => {
    const before = row.existed_before && row.snapshot_key
      ? await fs.readFile(resolveSnapshotPath(threadId, row.snapshot_key), "utf8")
      : "";
    const currentPath = resolveWorkspacePath(workspace.rootPath, row.file_path);
    const afterBuffer = await fs.readFile(currentPath).catch(() => Buffer.alloc(0));
    const after = afterBuffer.toString("utf8");
    const patch = createTwoFilesPatch(
      row.existed_before ? `a/${row.file_path}` : "/dev/null",
      `b/${row.file_path}`,
      before,
      after,
      "修改前",
      "当前内容",
      { context: 3 }
    );
    const patchLines = patch.split(/\r?\n/).slice(4);
    return {
      snapshotId: row.snapshot_id,
      turnId: row.turn_id,
      filePath: row.file_path,
      status: row.status,
      additions: patchLines.filter((line) => line.startsWith("+")).length,
      deletions: patchLines.filter((line) => line.startsWith("-")).length,
      patch,
      changedAfterSnapshot:
        Boolean(row.after_hash) && hashBuffer(afterBuffer) !== row.after_hash
    };
  }));
}

export async function rollbackWorkspaceTurn(input: {
  threadId: string;
  userId: string;
  turnId: string;
}): Promise<number> {
  const database = getDatabaseForThread(input.threadId);
  const rows = database.prepare(`
    SELECT *
    FROM workspace_turn_snapshots
    WHERE thread_id = ? AND user_id = ? AND turn_id = ? AND status = 'active'
    ORDER BY created_at DESC
  `).all(input.threadId, input.userId, input.turnId) as SnapshotRow[];
  const workspace = getThreadWorkspace(input.threadId, input.userId);
  const currentVersions = new Map<string, { existed: boolean; content: Buffer }>();

  // 如果文件在 Agent 修改后又被用户改过，则拒绝覆盖，避免回退误删用户新工作。
  for (const row of rows) {
    const target = resolveWorkspacePath(workspace.rootPath, row.file_path);
    const current = await fs.readFile(target).catch(() => null);
    currentVersions.set(row.file_path, {
      existed: Boolean(current),
      content: current ?? Buffer.alloc(0)
    });
    if (row.after_hash && hashBuffer(current ?? Buffer.alloc(0)) !== row.after_hash) {
      const actualHash = hashBuffer(current ?? Buffer.alloc(0));
      const message = `${row.file_path} 在本轮修改后又发生了变化，已停止回退以保护用户内容。`;
      saveWorkspaceTurnConflict({
        threadId: input.threadId,
        userId: input.userId,
        turnId: input.turnId,
        filePath: row.file_path,
        conflictType: "rollback_changed",
        expectedHash: row.after_hash,
        actualHash,
        message
      });
      throw new Error(message);
    }
  }

  try {
    for (const row of rows) {
      const target = resolveWorkspacePath(workspace.rootPath, row.file_path);
      if (row.existed_before && row.snapshot_key) {
        const before = await fs.readFile(
          resolveSnapshotPath(input.threadId, row.snapshot_key)
        );
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, before);
      } else {
        await fs.rm(target, { force: true });
      }
    }
  } catch (error) {
    // 回退本身失败时，尽量恢复到用户点击回退前的文件状态，避免留下半回退结果。
    for (const [filePath, current] of currentVersions) {
      const target = resolveWorkspacePath(workspace.rootPath, filePath);
      if (current.existed) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, current.content);
      } else {
        await fs.rm(target, { force: true });
      }
    }
    const message = `回退过程中发生错误，已尝试恢复回退前状态：${error instanceof Error ? error.message : String(error)}`;
    saveWorkspaceTurnConflict({
      threadId: input.threadId,
      userId: input.userId,
      turnId: input.turnId,
      filePath: "*",
      conflictType: "rollback_failed",
      message
    });
    throw new Error(message);
  }
  database.prepare(`
    UPDATE workspace_turn_snapshots
    SET status = 'rolled_back', rolled_back_at = ?
    WHERE thread_id = ? AND user_id = ? AND turn_id = ? AND status = 'active'
  `).run(new Date().toISOString(), input.threadId, input.userId, input.turnId);
  resolveWorkspaceTurnConflicts(input);
  return rows.length;
}
