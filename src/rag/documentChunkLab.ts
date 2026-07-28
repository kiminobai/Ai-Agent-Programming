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
  sourceType: "text" | "table" | "image_ocr" | "image_summary";
  pageNumber: number | null;
  blockIndex: number;
  locator: string;
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
      endChar: 0,
      sourceType: getDefaultChunkSourceType(document.fileType),
      pageNumber: null,
      blockIndex: index,
      locator: ""
    })),
    document.text,
    document.fileType
  );
}

function annotateChunkOffsets(
  chunks: DocumentChunk[],
  sourceText: string,
  fileType: UploadedFileType
): DocumentChunk[] {
  let searchFrom = 0;
  const pageRanges = buildPageRanges(sourceText);

  // 学习点：记录 chunk 在原文里的位置，后续可以做来源定位和文件预览。
  return chunks.map((chunk) => {
    const exactStart = sourceText.indexOf(chunk.content, searchFrom);
    const startChar = exactStart >= 0 ? exactStart : searchFrom;
    const endChar = startChar + chunk.content.length;
    const pageNumber = chunk.pageNumber ?? findPageNumber(pageRanges, startChar);
    searchFrom = Math.max(startChar + 1, endChar - 1);

    return {
      ...chunk,
      startChar,
      endChar,
      pageNumber,
      locator: buildChunkLocator({
        fileType,
        sourceType: chunk.sourceType,
        pageNumber,
        blockIndex: chunk.blockIndex,
        startChar,
        endChar
      })
    };
  });
}

function getDefaultChunkSourceType(
  fileType: UploadedFileType
): DocumentChunk["sourceType"] {
  // 学习点：当前默认解析出来的都是文本块。
  // 为什么这样：PDF 表格/图片后续会单独拆成 table/image_* chunk，现在先把类型字段预留好。
  return fileType === "image" ? "image_ocr" : "text";
}

function buildChunkLocator(input: {
  fileType: UploadedFileType;
  sourceType: DocumentChunk["sourceType"];
  pageNumber: number | null;
  blockIndex: number;
  startChar: number;
  endChar: number;
}): string {
  // 学习点：locator 是给“定位/预览/后续修改”用的稳定描述。
  // 为什么这样：只靠 chunk 文本很容易在文档更新后找错段落，至少要保存页码/块序号/字符范围。
  const parts = [
    `type=${input.sourceType}`,
    input.pageNumber ? `page=${input.pageNumber}` : `page=unknown`,
    `block=${input.blockIndex}`,
    `chars=${input.startChar}-${input.endChar}`,
    `fileType=${input.fileType}`
  ];

  return parts.join("; ");
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
    return extractPdfTextWithPageMarkers(fileBuffer);
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

async function extractPdfTextWithPageMarkers(fileBuffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(fileBuffer) });

  try {
    const info = await parser.getInfo().catch(() => undefined);
    const totalPages = Number(info?.total || 0);

    if (!totalPages) {
      const parsed = await parser.getText();
      return parsed.text || "";
    }

    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const parsed = await parser.getText({ partial: [pageNumber] });
      const text = normalizeText(parsed.text || "");

      if (!text) {
        continue;
      }

      // 学习点：给 PDF 文本插入页标记，后续 chunk 可以反推出页码。
      // 为什么这样：修改/引用 PDF 内容时，仅靠字符范围不够，页码能降低定位错误。
      pageTexts.push(`[PDF_PAGE:${pageNumber}]\n${text}`);
    }

    return pageTexts.join("\n\n");
  } finally {
    await parser.destroy();
  }
}

function buildPageRanges(
  sourceText: string
): Array<{ pageNumber: number; startChar: number; endChar: number }> {
  const markerPattern = /\[PDF_PAGE:(\d+)\]/g;
  const markers = [...sourceText.matchAll(markerPattern)].map((match) => ({
    pageNumber: Number(match[1]),
    startChar: match.index ?? 0
  }));

  return markers.map((marker, index) => ({
    pageNumber: marker.pageNumber,
    startChar: marker.startChar,
    endChar: markers[index + 1]?.startChar ?? sourceText.length
  }));
}

function findPageNumber(
  pageRanges: Array<{ pageNumber: number; startChar: number; endChar: number }>,
  startChar: number
): number | null {
  const range = pageRanges.find(
    (candidate) => startChar >= candidate.startChar && startChar < candidate.endChar
  );

  return range?.pageNumber ?? null;
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
