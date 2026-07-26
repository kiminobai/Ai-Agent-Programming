import crypto from "crypto";
import fs from "fs";
import path from "path";

const uploadRoot = path.join(process.cwd(), "data", "uploads");

export interface StoredUploadFile {
  fileId: string;
  storageKey: string;
  absolutePath: string;
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
