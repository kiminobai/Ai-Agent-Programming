import crypto from "crypto";
import fs from "fs";
import path from "path";

const uploadRoot = path.join(process.cwd(), "data", "uploads");
const pendingUploadRoot = path.join(uploadRoot, ".pending");
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
  // 学习点：真实文件放在 data/uploads 目录，不直接塞进数据库。
  // 数据库只保存 storageKey 这种相对路径，部署换域名/端口时不会被写死。
  const storageKey = path
    .join(input.userId, input.threadId, `${fileId}-${safeName}`)
    .replace(/\\/g, "/");
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
  const storageKey = path
    .join(input.userId, input.threadId, `${fileId}-${safeName}`)
    .replace(/\\/g, "/");
  const pendingStorageKey = `${fileId}-${safeName}`;
  const pendingAbsolutePath = path.resolve(pendingUploadRoot, pendingStorageKey);
  const absolutePath = resolveUploadStorageKey(storageKey);

  // 学习点：pending 文件只表示“后端已收到字节”，还没有进入当前对话上下文。
  // 为什么这样：如果解析失败、用户中断或服务异常，最多留下临时文件，不会覆盖旧文档记录。
  assertInsideUploadRoot(pendingAbsolutePath);
  await fs.promises.mkdir(pendingUploadRoot, { recursive: true });
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
    const entries = await fs.promises.readdir(pendingUploadRoot, {
      withFileTypes: true
    });

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }

        const absolutePath = path.resolve(pendingUploadRoot, entry.name);
        assertInsideUploadRoot(absolutePath);
        const stat = await fs.promises.stat(absolutePath);

        if (now - stat.mtimeMs < ttlMs) {
          return;
        }

        await fs.promises.rm(absolutePath, { force: true });
        deletedCount += 1;
      })
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return deletedCount;
}

export function resolveUploadStorageKey(storageKey: string): string {
  // 学习点：读取文件时，再把相对 storageKey 解析回项目内的绝对路径。
  const absolutePath = path.resolve(uploadRoot, storageKey);
  assertInsideUploadRoot(absolutePath);
  return absolutePath;
}

export async function deleteUploadThreadDirectory(input: {
  userId: string;
  threadId: string;
}): Promise<void> {
  // 学习点：删除对话时，也要删除这个对话对应的上传文件目录。
  const absolutePath = path.resolve(uploadRoot, input.userId, input.threadId);
  assertInsideUploadRoot(absolutePath);
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

function assertInsideUploadRoot(absolutePath: string): void {
  // 学习点：路径边界检查，防止 storageKey 被构造成项目目录外的路径。
  const root = path.resolve(uploadRoot) + path.sep;
  const target = path.resolve(absolutePath);

  if (!target.startsWith(root)) {
    throw new Error("Resolved upload path is outside the upload root.");
  }
}
