import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDatabaseForThread, sqliteDb, workSqliteDb } from "../db/sqlite";
import { getThreadById } from "../threads/threadRepository";
import { getWorkTaskDirectory } from "../workspace/localWorkStorage";

const generatedRoot = path.join(process.cwd(), "data", "generated");
fs.mkdirSync(generatedRoot, { recursive: true });

export interface GeneratedFileRecord {
  fileId: string;
  threadId: string;
  userId: string;
  turnId?: string;
  sourceFileId?: string;
  parentFileId?: string;
  version: number;
  editMode: "generated" | "preserve-layout" | "regenerated";
  fileName: string;
  storageKey: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export async function createGeneratedFile(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  fileName: string;
  content: string;
}): Promise<GeneratedFileRecord> {
  return createGeneratedBinaryFile({
    ...input,
    buffer: Buffer.from(input.content, "utf8")
  });
}

export async function createGeneratedBinaryFile(input: {
  threadId: string;
  userId: string;
  turnId?: string;
  fileName: string;
  buffer: Buffer;
  mimeType?: string;
  sourceFileId?: string;
  parentFileId?: string;
  version?: number;
  editMode?: GeneratedFileRecord["editMode"];
}): Promise<GeneratedFileRecord> {
  const thread = getThreadById(input.threadId, input.userId);
  if (!thread) {
    throw new Error("当前对话不存在，无法保存生成文件。");
  }
  if (thread.mode === "work" && input.editMode !== "preserve-layout") {
    throw new Error(
      "Work 模式的新文件应写入已选择的工作区；只有上传原件的修改版本会进入任务下载目录。"
    );
  }
  const fileId = crypto.randomUUID();
  const fileName = sanitizeGeneratedFileName(input.fileName);
  const storageKey =
    thread.mode === "work"
      ? `work/${input.threadId}/${fileId}-${fileName}`
      : path
          .join(input.userId, input.threadId, `${fileId}-${fileName}`)
          .replace(/\\/g, "/");
  const absolutePath = resolveGeneratedFileStorageKey(storageKey);
  const contentBuffer = input.buffer;
  const createdAt = new Date().toISOString();
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, contentBuffer);

  const record: GeneratedFileRecord = {
    fileId,
    threadId: input.threadId,
    userId: input.userId,
    turnId: input.turnId,
    sourceFileId: input.sourceFileId,
    parentFileId: input.parentFileId,
    version: input.version ?? 1,
    editMode: input.editMode ?? "generated",
    fileName,
    storageKey,
    mimeType: input.mimeType || inferMimeType(fileName),
    fileSize: contentBuffer.byteLength,
    createdAt
  };
  try {
    getDatabaseForThread(input.threadId)
      .prepare(
        `INSERT INTO generated_files (
          file_id, thread_id, user_id, turn_id, source_file_id,
          parent_file_id, version, edit_mode, file_name,
          storage_key, mime_type, file_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.fileId,
        record.threadId,
        record.userId,
        record.turnId ?? null,
        record.sourceFileId ?? null,
        record.parentFileId ?? null,
        record.version,
        record.editMode,
        record.fileName,
        record.storageKey,
        record.mimeType,
        record.fileSize,
        record.createdAt
      );
  } catch (error) {
    // 元数据写入失败时同步删除文件，避免磁盘上出现无法下载的孤儿文件。
    await fs.promises.rm(absolutePath, { force: true });
    throw error;
  }
  return record;
}

export function listGeneratedFiles(
  threadId: string,
  userId: string
): GeneratedFileRecord[] {
  return getDatabaseForThread(threadId)
    .prepare(
      `SELECT file_id AS fileId, thread_id AS threadId, user_id AS userId,
              turn_id AS turnId, source_file_id AS sourceFileId,
              parent_file_id AS parentFileId, version, edit_mode AS editMode,
              file_name AS fileName, storage_key AS storageKey,
              mime_type AS mimeType, file_size AS fileSize, created_at AS createdAt
       FROM generated_files
       WHERE thread_id = ? AND user_id = ?
       ORDER BY created_at ASC`
    )
    .all(threadId, userId) as GeneratedFileRecord[];
}

export function getGeneratedFile(
  fileId: string,
  userId: string
): GeneratedFileRecord | undefined {
  const readFrom = (database: typeof sqliteDb) =>
    database.prepare(
      `SELECT file_id AS fileId, thread_id AS threadId, user_id AS userId,
              turn_id AS turnId, source_file_id AS sourceFileId,
              parent_file_id AS parentFileId, version, edit_mode AS editMode,
              file_name AS fileName, storage_key AS storageKey,
              mime_type AS mimeType, file_size AS fileSize, created_at AS createdAt
       FROM generated_files
       WHERE file_id = ? AND user_id = ?`
    )
    .get(fileId, userId) as GeneratedFileRecord | undefined;
  return readFrom(workSqliteDb) ?? readFrom(sqliteDb);
}

export function resolveGeneratedFileStorageKey(storageKey: string): string {
  const normalized = storageKey.replace(/\\/g, "/");
  const [scope, ...parts] = normalized.split("/");
  const threadId = scope === "work" ? parts.shift() || "" : "";
  const root =
    scope === "work"
      ? getWorkTaskDirectory(threadId, "downloads")
      : generatedRoot;
  const relativeParts = scope === "work" ? parts : [scope, ...parts];
  const absolutePath = path.resolve(root, ...relativeParts);
  const rootPrefix = `${path.resolve(root)}${path.sep}`.toLowerCase();
  if (!absolutePath.toLowerCase().startsWith(rootPrefix)) {
    throw new Error("生成文件路径超出存储目录。");
  }
  return absolutePath;
}

export async function deleteGeneratedThreadDirectory(input: {
  userId: string;
  threadId: string;
}): Promise<void> {
  const target = path.resolve(generatedRoot, input.userId, input.threadId);
  const rootPrefix = `${path.resolve(generatedRoot)}${path.sep}`.toLowerCase();
  if (!target.toLowerCase().startsWith(rootPrefix)) {
    throw new Error("生成文件清理路径超出存储目录。");
  }
  await fs.promises.rm(target, { recursive: true, force: true });
}

function sanitizeGeneratedFileName(fileName: string): string {
  const baseName = path.basename(fileName.trim()).replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
  if (!baseName || baseName === "." || baseName === "..") {
    return "generated.txt";
  }
  return baseName.slice(0, 120);
}

function inferMimeType(fileName: string): string {
  return (
    {
      ".md": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".ts": "text/typescript; charset=utf-8",
      ".tsx": "text/typescript; charset=utf-8",
      ".py": "text/x-python; charset=utf-8",
      ".xml": "application/xml; charset=utf-8",
      ".yaml": "application/yaml; charset=utf-8",
      ".yml": "application/yaml; charset=utf-8",
      ".pdf": "application/pdf",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }[path.extname(fileName).toLowerCase()] || "application/octet-stream"
  );
}
