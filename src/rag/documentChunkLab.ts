import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { extractTextFromImage } from "./imageOcrExtractor";
import {
  extractTextFromDocx,
  extractTextFromHtml,
  extractTextFromSpreadsheet
} from "./officeTextExtractor";
import { extractTextFromPptx } from "./pptxTextExtractor";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";

/**
 * 学习点：这是后端统一管理的 RAG 切分和检索配置。
 *
 * 用户上传文件时，不会把整份文档直接塞给模型。
 * 后端会先提取文本、切 chunk，等用户真正提问时再检索相关片段。
 */
export const RAG_RETRIEVAL_CONFIG = {
  // 学习点：chunkSize 是每个片段的大概长度，overlap 是相邻片段的重叠部分。
  // 重叠是为了避免答案刚好被切断在两个 chunk 中间。
  chunkSize: 800,
  chunkOverlap: 120,
  // 学习点：topK 是最终送给 LLM 的片段数量。
  // candidateK 是中间候选池，先多找一些，再做 rerank。
  topK: 6,
  hybridCandidateK: 16,
  rerankCandidateK: 24,
  // 学习点：全文分析也不能无限塞上下文，只能在字符预算内尽量覆盖更多位置。
  wholeDocumentMaxContextCharacters: 14_000,
  wholeDocumentChunkPreviewCharacters: 520,
  minimumUsefulHybridScore: 0.08,
  maxChunkCharacters: 1_000,
  maxQueryTerms: 32
} as const;

export interface DocumentChunk {
  index: number;
  content: string;
  charCount: number;
  startChar: number;
  endChar: number;
}

export type UploadedFileType =
  | "markdown"
  | "pdf"
  | "text"
  | "presentation"
  | "word"
  | "spreadsheet"
  | "html"
  | "image"
  | "binary";

/**
 * 学习点：这是“用户上传文件后”的第一步。
 *
 * 第 1 步：判断文件类型。
 * 第 2 步：能解析的文件提取成纯文本。
 * 第 3 步：把文本和文件元数据保存到当前 thread。
 * 真正的检索会等用户提问时再发生。
 */
export async function createUploadedDocumentRecord(input: {
  threadId: string;
  userId: string;
  fileId: string;
  fileName: string;
  storageKey: string;
  mimeType: string;
  fileSize: number;
  fileBuffer: Buffer;
}): Promise<UploadedDocumentRecord> {
  const extension = getExtension(input.fileName);
  const fileType = getFileType(extension);
  const canParseText = isTextExtractable(fileType, extension);
  const text = canParseText
    ? normalizeText(await extractTextFromUpload(input.fileBuffer, fileType, extension))
    : "";
  const parseStatus = canParseText ? (text ? "parsed" : "empty") : "unsupported";

  return {
    threadId: input.threadId,
    userId: input.userId,
    fileId: input.fileId,
    fileName: input.fileName,
    originalName: input.fileName,
    storageKey: input.storageKey,
    mimeType: input.mimeType,
    fileType,
    fileSize: input.fileSize,
    text,
    uploadedAt: new Date().toISOString(),
    parseStatus,
    indexStatus: text ? "pending" : "unsupported"
  };
}

export async function splitUploadedDocument(
  document: UploadedDocumentRecord
): Promise<DocumentChunk[]> {
  // 学习点：LangChain splitter 会把长文档切成多个适合检索的小片段。
  // 不同文件类型使用不同分隔符，是为了尽量保留标题、段落、句子结构。
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: RAG_RETRIEVAL_CONFIG.chunkSize,
    chunkOverlap: RAG_RETRIEVAL_CONFIG.chunkOverlap,
    separators: getSeparators(document.fileType)
  });

  const splitTexts = await splitter.splitText(document.text);
  return annotateChunkOffsets(
    splitTexts.map((content, index) => ({
      index,
      content,
      charCount: content.length,
      startChar: 0,
      endChar: 0
    })),
    document.text
  );
}

function annotateChunkOffsets(
  chunks: DocumentChunk[],
  sourceText: string
): DocumentChunk[] {
  let searchFrom = 0;

  // 学习点：记录 chunk 在原文里的位置，后续可以做来源定位和文件预览。
  return chunks.map((chunk) => {
    const exactStart = sourceText.indexOf(chunk.content, searchFrom);
    const startChar = exactStart >= 0 ? exactStart : searchFrom;
    const endChar = startChar + chunk.content.length;
    searchFrom = Math.max(startChar + 1, endChar - 1);

    return {
      ...chunk,
      startChar,
      endChar
    };
  });
}

function getExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  return lastDotIndex >= 0 ? fileName.slice(lastDotIndex).toLowerCase() : "";
}

function getFileType(extension: string): UploadedFileType {
  if (extension === ".pdf") {
    return "pdf";
  }

  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }

  if (extension === ".txt") {
    return "text";
  }

  if ([".doc", ".docx"].includes(extension)) {
    return "word";
  }

  if ([".xls", ".xlsx", ".csv"].includes(extension)) {
    return "spreadsheet";
  }

  if ([".html", ".htm"].includes(extension)) {
    return "html";
  }

  if ([".ppt", ".pptx", ".key"].includes(extension)) {
    return "presentation";
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(extension)) {
    return "image";
  }

  return "binary";
}

async function extractTextFromUpload(
  fileBuffer: Buffer,
  fileType: UploadedFileType,
  extension = ""
): Promise<string> {
  // 学习点：不同文件格式最后都会转成纯文本。
  // 这样 PDF、Word、PPT、Excel 后面都能走同一套 chunk / embedding 流程。
  if (fileType === "pdf") {
    const parser = new PDFParse({ data: new Uint8Array(fileBuffer) });

    try {
      const parsed = await parser.getText();
      return parsed.text || "";
    } finally {
      await parser.destroy();
    }
  }

  if (fileType === "presentation" && extension === ".pptx") {
    return extractTextFromPptx(fileBuffer);
  }

  if (fileType === "word" && extension === ".docx") {
    return extractTextFromDocx(fileBuffer);
  }

  if (fileType === "spreadsheet") {
    return extractTextFromSpreadsheet(fileBuffer);
  }

  if (fileType === "html") {
    return extractTextFromHtml(fileBuffer);
  }

  if (fileType === "image") {
    return extractTextFromImage(fileBuffer);
  }

  return fileBuffer.toString("utf8");
}

function isTextExtractable(fileType: UploadedFileType, extension: string): boolean {
  // 学习点：这里判断“这个文件能不能提取出可检索文本”。
  // 图片目前只提取文字，不等于模型已经能理解图片画面。
  return (
    fileType === "markdown" ||
    fileType === "pdf" ||
    fileType === "text" ||
    (fileType === "presentation" && extension === ".pptx") ||
    (fileType === "word" && extension === ".docx") ||
    fileType === "spreadsheet" ||
    fileType === "html" ||
    fileType === "image"
  );
}

function getSeparators(fileType: UploadedFileType): string[] {
  if (fileType === "markdown") {
    // 学习点：Markdown 优先按标题切，能更好保留章节结构。
    return ["\n# ", "\n## ", "\n### ", "\n\n", "\n", "。", "，", "；", ". ", " ", ""];
  }

  // 学习点：普通文本优先按段落、换行、句子切。
  return ["\n\n", "\n", "。", "，", "；", ". ", " ", ""];
}

function normalizeText(input: string): string {
  // 学习点：清洗文本不是为了改变内容，而是减少无意义空白和控制字符。
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
