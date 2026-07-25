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
  const absolutePath = path.resolve(uploadRoot, storageKey);
  assertInsideUploadRoot(absolutePath);
  return absolutePath;
}

export async function deleteUploadThreadDirectory(input: {
  userId: string;
  threadId: string;
}): Promise<void> {
  const absolutePath = path.resolve(uploadRoot, input.userId, input.threadId);
  assertInsideUploadRoot(absolutePath);
  await fs.promises.rm(absolutePath, { recursive: true, force: true });
}

function sanitizeFileName(fileName: string): string {
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
  const root = path.resolve(uploadRoot) + path.sep;
  const target = path.resolve(absolutePath);

  if (!target.startsWith(root)) {
    throw new Error("Resolved upload path is outside the upload root.");
  }
}
