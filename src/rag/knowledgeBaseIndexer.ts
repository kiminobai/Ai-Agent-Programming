import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createUploadedDocumentRecord } from "./documentChunkLab";
import { saveKnowledgeBaseDocument } from "./knowledgeBaseStore";
import { listKnowledgeBaseFiles } from "./knowledgeBaseStorage";
import { saveUploadedDocument } from "./uploadedDocumentStore";
import { buildVectorDocumentIndex } from "./vectorDocumentIndex";

export interface KnowledgeBaseIndexSummary {
  knowledgeBaseId: string;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  documents: Array<{
    documentId: string;
    fileName: string;
    version: string;
    parseStatus: string;
    indexStatus: string;
    chunkCount: number;
    textLength: number;
  }>;
}

export async function indexKnowledgeBase(
  knowledgeBaseId: string
): Promise<KnowledgeBaseIndexSummary> {
  // 学习点：这是“离线索引知识库”的入口。
  // 它把 data/knowledge-bases 里的文件批量解析、切分、embedding，并写入索引。
  // 所以不是每次聊天都跑，只有新增/修改知识库文件后才需要重新执行。
  const files = await listKnowledgeBaseFiles(knowledgeBaseId);
  const documents: KnowledgeBaseIndexSummary["documents"] = [];
  let indexedFiles = 0;
  let skippedFiles = 0;

  for (const file of files) {
    const fileBuffer = await fs.promises.readFile(file.absolutePath);
    // 学习点：documentId 要稳定。
    // 同一个知识库文件重复索引时，应覆盖同一条记录，而不是生成一堆新记录。
    const documentId = buildKnowledgeBaseDocumentId(
      file.knowledgeBaseId,
      file.storageKey
    );
    // 学习点：把知识库文件伪装成 uploaded document。
    // 这样知识库和用户上传文件可以复用同一套解析、切分、索引逻辑。
    const uploadedLikeRecord = await createUploadedDocumentRecord({
      threadId: documentId,
      userId: `knowledge-base:${knowledgeBaseId}`,
      fileId: documentId,
      fileName: file.fileName,
      storageKey: file.storageKey,
      mimeType: guessMimeType(file.fileName),
      fileSize: file.fileSize,
      fileBuffer
    });

    let chunkCount = 0;
    let indexStatus = uploadedLikeRecord.indexStatus;

    if (uploadedLikeRecord.text.trim()) {
      // 学习点：保存 uploaded-like record 后，检索时才能用 documentId 找回这份文档。
      saveUploadedDocument(uploadedLikeRecord);
      const index = await buildVectorDocumentIndex(uploadedLikeRecord);
      chunkCount = index.chunkCount;
      indexStatus = "indexed";
      indexedFiles += 1;
    } else {
      skippedFiles += 1;
    }

    saveKnowledgeBaseDocument({
      documentId,
      knowledgeBaseId,
      version: file.version,
      fileName: file.fileName,
      storageKey: file.storageKey,
      fileType: uploadedLikeRecord.fileType,
      fileSize: file.fileSize,
      textLength: uploadedLikeRecord.text.length,
      chunkCount,
      parseStatus: uploadedLikeRecord.parseStatus,
      indexStatus,
      indexedAt: new Date().toISOString()
    });

    documents.push({
      documentId,
      fileName: file.fileName,
      version: file.version,
      parseStatus: uploadedLikeRecord.parseStatus,
      indexStatus,
      chunkCount,
      textLength: uploadedLikeRecord.text.length
    });
  }

  return {
    knowledgeBaseId,
    totalFiles: files.length,
    indexedFiles,
    skippedFiles,
    documents
  };
}

function buildKnowledgeBaseDocumentId(
  knowledgeBaseId: string,
  storageKey: string
): string {
  // 学习点：用知识库 ID + 相对路径生成稳定 hash。
  const hash = crypto
    .createHash("sha1")
    .update(`${knowledgeBaseId}:${storageKey}`)
    .digest("hex")
    .slice(0, 16);

  return `kb-${knowledgeBaseId}-${hash}`;
}

function guessMimeType(fileName: string): string {
  // 学习点：知识库索引脚本直接读磁盘文件，没有浏览器上传时的 mimeType。
  // 所以这里根据扩展名补一个够用的类型。
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".pdf") {
    return "application/pdf";
  }

  if (extension === ".md" || extension === ".markdown" || extension === ".txt") {
    return "text/plain";
  }

  if (extension === ".pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }

  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (extension === ".xlsx" || extension === ".xls" || extension === ".csv") {
    return "application/vnd.ms-excel";
  }

  if (extension === ".html" || extension === ".htm") {
    return "text/html";
  }

  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(extension)) {
    return `image/${extension.replace(".", "").replace("jpg", "jpeg")}`;
  }

  return "application/octet-stream";
}
