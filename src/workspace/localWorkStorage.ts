import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";

function getFallbackDocumentsDirectory(): string {
  // Electron 会传入系统 app.getPath("documents")。普通 Node 启动时按平台规范回退。
  const home = os.homedir();
  if (process.platform === "linux") {
    const xdgDocuments = process.env.XDG_DOCUMENTS_DIR?.trim();
    if (xdgDocuments) {
      return xdgDocuments.replace(/^\$HOME/, home);
    }
  }
  return path.join(home, "Documents");
}

export const WORK_DATA_ROOT = path.resolve(
  process.env.KIMIBAI_WORK_DATA_ROOT ||
    path.join(getFallbackDocumentsDirectory(), "KimiBai")
);
export const WORK_DATABASE_DIR = path.join(WORK_DATA_ROOT, "data");
export const WORK_SQLITE_DB_PATH = path.join(WORK_DATABASE_DIR, "work.sqlite");
export const WORK_TASKS_ROOT = path.join(WORK_DATA_ROOT, "tasks");
export const WORK_INDEXES_ROOT = path.join(WORK_DATA_ROOT, "indexes");
export const DEFAULT_WORKSPACE_ROOT = path.join(
  WORK_DATA_ROOT,
  "default-workspace"
);

for (const directory of [
  WORK_DATABASE_DIR,
  WORK_TASKS_ROOT,
  WORK_INDEXES_ROOT,
  DEFAULT_WORKSPACE_ROOT
]) {
  fs.mkdirSync(directory, { recursive: true });
}

export function getWorkTaskDirectory(
  threadId: string,
  kind:
    | "uploads"
    | "generated"
    | "downloads"
    | "extracted"
    | "snapshots"
    | "temp"
): string {
  return path.join(WORK_TASKS_ROOT, threadId, kind);
}

export async function deleteWorkThreadStorage(threadId: string): Promise<void> {
  await Promise.all([
    fs.promises.rm(path.join(WORK_TASKS_ROOT, threadId), {
      recursive: true,
      force: true
    }),
    fs.promises.rm(path.join(WORK_INDEXES_ROOT, threadId), {
      recursive: true,
      force: true
    })
  ]);
}

export async function clearWorkThreadContextFiles(threadId: string): Promise<void> {
  // 保留用户源码、生成文件和回退快照，只清除当前附件及其临时解析/检索数据。
  await Promise.all([
    fs.promises.rm(getWorkTaskDirectory(threadId, "uploads"), {
      recursive: true,
      force: true
    }),
    fs.promises.rm(getWorkTaskDirectory(threadId, "extracted"), {
      recursive: true,
      force: true
    }),
    fs.promises.rm(getWorkTaskDirectory(threadId, "temp"), {
      recursive: true,
      force: true
    }),
    fs.promises.rm(path.join(WORK_INDEXES_ROOT, threadId), {
      recursive: true,
      force: true
    })
  ]);
}
