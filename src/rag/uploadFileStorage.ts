import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDatabaseForThread, sqliteDb } from "../db/sqlite";
import {
  getWorkTaskDirectory,
  WORK_TASKS_ROOT
} from "../workspace/localWorkStorage";

const chatUploadRoot = path.join(process.cwd(), "data", "uploads");
const chatPendingUploadRoot = path.join(chatUploadRoot, ".pending");
const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredUploadFile {
  fileId: string;
  storageKey: string;
  absolutePath: string;
}

export interface PendingUploadFile extends StoredUploadFile {
  pendingStorageKey: string;
  pendingAbsolutePath: string;
}

export async function saveUploadFile(input: {
  userId: string;
  threadId: string;
  originalName: string;
  buffer: Buffer;
}): Promise<StoredUploadFile> {
  const fileId = crypto.randomUUID();
  const safeName = sanitizeFileName(input.originalName);
  const storageKey = createStorageKey(
    input.userId,
    input.threadId,
    `${fileId}-${safeName}`
  );
  const absolutePath = resolveUploadStorageKey(storageKey);

  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, input.buffer);

  return {
    fileId,
    storageKey,
    absolutePath
  };
}

export async function savePendingUploadFile(input: {
  userId: string;
  threadId: string;
  originalName: string;
  buffer: Buffer;
}): Promise<PendingUploadFile> {
  const fileId = crypto.randomUUID();
  const safeName = sanitizeFileName(input.originalName);
  const fileName = `${fileId}-${safeName}`;
  const isWorkThread = getDatabaseForThread(input.threadId) !== sqliteDb;
  const storageKey = createStorageKey(
    input.userId,
    input.threadId,
    fileName
  );
  const pendingStorageKey = `${fileId}-${safeName}`;
  const pendingRoot = isWorkThread
    ? getWorkTaskDirectory(input.threadId, "temp")
    : chatPendingUploadRoot;
  const pendingAbsolutePath = path.resolve(pendingRoot, pendingStorageKey);
  const absolutePath = resolveUploadStorageKey(storageKey);

  // 学习点：pending 文件只表示“后端已收到字节”，还没有进入当前对话上下文。
  // 为什么这样：如果解析失败、用户中断或服务异常，最多留下临时文件，不会覆盖旧文档记录。
  assertInsideRoot(pendingAbsolutePath, pendingRoot);
  await fs.promises.mkdir(pendingRoot, { recursive: true });
  await fs.promises.writeFile(pendingAbsolutePath, input.buffer);

  return {
    fileId,
    storageKey,
    absolutePath,
    pendingStorageKey,
    pendingAbsolutePath
  };
}

export async function commitPendingUploadFile(
  pendingUpload: PendingUploadFile
): Promise<StoredUploadFile> {
  // 学习点：只有解析和校验通过后，pending 文件才会移动到正式目录。
  // 为什么这样：正式目录里的文件都应该能被 SQLite 记录引用，减少孤儿文件。
  await fs.promises.mkdir(path.dirname(pendingUpload.absolutePath), {
    recursive: true
  });
  await fs.promises.rename(
    pendingUpload.pendingAbsolutePath,
    pendingUpload.absolutePath
  );

  return {
    fileId: pendingUpload.fileId,
    storageKey: pendingUpload.storageKey,
    absolutePath: pendingUpload.absolutePath
  };
}

export async function deletePendingUploadFile(
  pendingUpload: PendingUploadFile | undefined
): Promise<void> {
  if (!pendingUpload) {
    return;
  }

  // 学习点：失败时清理 pending 文件，不碰正式目录。
  // 为什么这样：正式目录可能有旧的有效附件，不能因为本次失败而误删。
  await fs.promises.rm(pendingUpload.pendingAbsolutePath, { force: true });
}

export async function cleanupStalePendingUploads(
  ttlMs = DEFAULT_PENDING_TTL_MS
): Promise<number> {
  // 学习点：处理“上传一半断网/进程中断”留下的 pending 文件。
  // 为什么这样：这种残留不会写入 SQLite，但长期不清理会浪费磁盘空间。
  const now = Date.now();
  let deletedCount = 0;

  try {
    const roots = [chatPendingUploadRoot];
    const taskEntries = await fs.promises
      .readdir(WORK_TASKS_ROOT, { withFileTypes: true })
      .catch(() => []);
    for (const taskEntry of taskEntries) {
      if (taskEntry.isDirectory()) {
        roots.push(getWorkTaskDirectory(taskEntry.name, "temp"));
      }
    }

    for (const pendingRoot of roots) {
      const entries = await fs.promises
        .readdir(pendingRoot, { withFileTypes: true })
        .catch(() => []);
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isFile()) {
            return;
          }
          const absolutePath = path.resolve(pendingRoot, entry.name);
          assertInsideRoot(absolutePath, pendingRoot);
          const stat = await fs.promises.stat(absolutePath);
          if (now - stat.mtimeMs >= ttlMs) {
            await fs.promises.rm(absolutePath, { force: true });
            deletedCount += 1;
          }
        })
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return deletedCount;
}

export function resolveUploadStorageKey(storageKey: string): string {
  const normalized = storageKey.replace(/\\/g, "/");
  const [scope, ...parts] = normalized.split("/");
  let root = chatUploadRoot;
  let relativeParts = [scope, ...parts];

  if (scope === "work") {
    const [threadId, ...fileParts] = parts;
    if (!threadId || fileParts.length !== 1) {
      throw new Error("Invalid Work upload storage key.");
    }
    root = getWorkTaskDirectory(threadId, "uploads");
    relativeParts = fileParts;
  } else if (scope === "chat") {
    relativeParts = parts;
  }

  // storageKey 保持相对形式，部署地址变化不会影响磁盘定位。
  const absolutePath = path.resolve(root, ...relativeParts);
  assertInsideRoot(absolutePath, root);
  return absolutePath;
}

export async function deleteUploadThreadDirectory(input: {
  userId: string;
  threadId: string;
}): Promise<void> {
  // 学习点：删除对话时，也要删除这个对话对应的上传文件目录。
  const absolutePath = path.resolve(
    chatUploadRoot,
    input.userId,
    input.threadId
  );
  assertInsideRoot(absolutePath, chatUploadRoot);
  await fs.promises.rm(absolutePath, { recursive: true, force: true });
}

export async function deleteStoredUploadFile(storageKey: string): Promise<void> {
  // 学习点：单个文件上传失败时，只清理这次临时写入的文件。
  // 为什么这样：不能删除整个 thread 目录，否则会误删当前对话里原本有效的旧附件。
  const absolutePath = resolveUploadStorageKey(storageKey);
  await fs.promises.rm(absolutePath, { force: true });
}

function sanitizeFileName(fileName: string): string {
  // 学习点：用户原始文件名不能直接用于路径。
  // 这里保留可读名字，同时去掉可能影响路径安全的字符。
  const extension = path.extname(fileName);
  const baseName = path
    .basename(fileName, extension)
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  return `${baseName || "upload"}${extension.toLowerCase()}`;
}

function createStorageKey(
  userId: string,
  threadId: string,
  fileName: string
): string {
  const scope = getDatabaseForThread(threadId) === sqliteDb ? "chat" : "work";
  return scope === "work"
    ? `work/${threadId}/${fileName}`
    : path.join("chat", userId, threadId, fileName).replace(/\\/g, "/");
}

function assertInsideRoot(absolutePath: string, allowedRoot: string): void {
  // 路径边界检查保证附件无法逃逸到当前模式的存储根目录之外。
  const root = path.resolve(allowedRoot) + path.sep;
  const target = path.resolve(absolutePath);

  if (!target.startsWith(root)) {
    throw new Error("Resolved upload path is outside the upload root.");
  }
}
