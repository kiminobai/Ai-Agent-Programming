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
  const after = await fs.readFile(input.absolutePath);
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

  // 如果文件在 Agent 修改后又被用户改过，则拒绝覆盖，避免回退误删用户新工作。
  for (const row of rows) {
    const target = resolveWorkspacePath(workspace.rootPath, row.file_path);
    const current = await fs.readFile(target).catch(() => Buffer.alloc(0));
    if (row.after_hash && hashBuffer(current) !== row.after_hash) {
      throw new Error(
        `${row.file_path} 在本轮修改后又发生了变化，已停止回退以保护用户内容。`
      );
    }
  }

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
  database.prepare(`
    UPDATE workspace_turn_snapshots
    SET status = 'rolled_back', rolled_back_at = ?
    WHERE thread_id = ? AND user_id = ? AND turn_id = ? AND status = 'active'
  `).run(new Date().toISOString(), input.threadId, input.userId, input.turnId);
  return rows.length;
}
