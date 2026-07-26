import fs from "fs";
import path from "path";

export const knowledgeBaseRoot = path.join(process.cwd(), "data", "knowledge-bases");

export interface KnowledgeBaseFile {
  knowledgeBaseId: string;
  fileName: string;
  storageKey: string;
  absolutePath: string;
  fileSize: number;
  version: string;
}

const SUPPORTED_FILE_PATTERN =
  /\.(md|markdown|txt|pdf|pptx|docx|xlsx|xls|csv|html|htm|png|jpe?g|webp|bmp)$/i;

export async function listKnowledgeBaseFiles(
  knowledgeBaseId: string
): Promise<KnowledgeBaseFile[]> {
  // 学习点：知识库文件由开发者/学习者放到 data/knowledge-bases/{knowledgeBaseId}。
  // 这里只扫描支持解析的文件，不在用户每次提问时临时遍历磁盘。
  const basePath = resolveKnowledgeBasePath(knowledgeBaseId);
  const entries = await fs.promises.readdir(basePath, { withFileTypes: true });
  const files: KnowledgeBaseFile[] = [];

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.name.toLowerCase() === "readme.md" ||
      !SUPPORTED_FILE_PATTERN.test(entry.name)
    ) {
      continue;
    }

    const absolutePath = path.join(basePath, entry.name);
    const stat = await fs.promises.stat(absolutePath);
    // 学习点：数据库只保存 storageKey，不保存绝对路径。
    // 这样项目目录移动后，历史记录仍然可以重新解析。
    const storageKey = path
      .relative(knowledgeBaseRoot, absolutePath)
      .replace(/\\/g, "/");

    files.push({
      knowledgeBaseId,
      fileName: entry.name,
      storageKey,
      absolutePath,
      fileSize: stat.size,
      version: extractVersion(entry.name)
    });
  }

  return files.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export function resolveKnowledgeBaseStorageKey(storageKey: string): string {
  // 学习点：从数据库 storageKey 反解文件路径时，也要做目录边界检查。
  const absolutePath = path.resolve(knowledgeBaseRoot, storageKey);
  assertInsideKnowledgeBaseRoot(absolutePath);
  return absolutePath;
}

function resolveKnowledgeBasePath(knowledgeBaseId: string): string {
  const safeKnowledgeBaseId = knowledgeBaseId.replace(/[^\w.-]+/g, "-");
  const absolutePath = path.resolve(knowledgeBaseRoot, safeKnowledgeBaseId);
  assertInsideKnowledgeBaseRoot(absolutePath);
  return absolutePath;
}

function extractVersion(fileName: string): string {
  // 学习点：从文件名里提取 v1/v2/v8 这种版本号，方便多版本资料对比。
  const match = fileName.match(/(?:^|[_\-\s])v(\d+)(?:[_\-\s.]|$)/i);
  return match ? `v${match[1]}` : "";
}

function assertInsideKnowledgeBaseRoot(absolutePath: string): void {
  // 学习点：防止 knowledgeBaseId 或 storageKey 造成路径穿越。
  const root = path.resolve(knowledgeBaseRoot) + path.sep;
  const target = path.resolve(absolutePath);

  if (!target.startsWith(root)) {
    throw new Error("Resolved knowledge base path is outside the knowledge base root.");
  }
}
