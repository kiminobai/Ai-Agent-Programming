import { Document } from "@langchain/core/documents";
import {
  loadUploadedDocuments,
  renderDocumentsAsStoredText,
  restoreLangChainDocuments,
  storeLangChainDocuments
} from "./langChainDocumentLoader";
import { splitDocumentsWithStructure } from "./structuredDocumentChunker";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";

export const RAG_CHUNKING_VERSION = "structured-v1";

/**
 * 学习点：这是后端统一管理的 RAG 切分和检索配置。
 *
 * 用户上传文件时，不会把整份文档直接塞给模型。
 * 后端会先提取文本、切 chunk，等用户真正提问时再检索相关片段。
 */
export const RAG_RETRIEVAL_CONFIG = {
  // 学习点：先按结构和语义组成目标块，再用 Token 上限保护模型上下文。
  // overlap 只用于超长正文的最终字符递归切分，不跨表格、图片或章节边界。
  targetChunkTokens: 420,
  maxChunkTokens: 600,
  chunkOverlapTokens: 60,
  semanticSimilarityThreshold: 0.72,
  semanticEmbeddingBatchSize: 32,
  // 学习点：topK 是最终送给 LLM 的片段数量。
  // candidateK 是中间候选池，先多找一些，再做 rerank。
  topK: 6,
  hybridCandidateK: 16,
  rerankCandidateK: 24,
  // 学习点：全文分析也不能无限塞上下文，只能在字符预算内尽量覆盖更多位置。
  wholeDocumentMaxContextCharacters: 14_000,
  wholeDocumentChunkPreviewCharacters: 520,
  minimumUsefulHybridScore: 0.08,
  maxChunkCharacters: 2_400,
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
  tokenCount: number;
  splitStrategy: string;
  parentBlockIndexes: number[];
  chunkingVersion: string;
  blockType?: string;
  sectionPath?: string[];
  boundingBox?: Record<string, unknown> | null;
  links?: string[];
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
  const loadedDocuments = canParseText
    ? await loadUploadedDocuments({
        fileId: input.fileId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileBuffer: input.fileBuffer,
        fileType
      })
    : [];
  const text = normalizeText(renderDocumentsAsStoredText(loadedDocuments));
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
    loaderDocuments: storeLangChainDocuments(loadedDocuments),
    uploadedAt: new Date().toISOString(),
    parseStatus,
    indexStatus: text ? "pending" : "unsupported"
  };
}

export async function splitUploadedDocument(
  document: UploadedDocumentRecord
): Promise<DocumentChunk[]> {
  const sourceDocuments = document.loaderDocuments.length
    ? restoreLangChainDocuments(document.loaderDocuments)
    : [
        new Document({
          pageContent: document.text,
          metadata: {
            source: document.fileName,
            fileId: document.fileId,
            fileType: document.fileType,
            loader: "LegacyStoredTextLoader"
          }
        })
      ];
  // 四层切分顺序：结构 -> 语义 -> Token -> 超长块字符递归兜底。
  const splitDocuments = await splitDocumentsWithStructure(
    sourceDocuments,
    document.fileType,
    {
      targetTokens: RAG_RETRIEVAL_CONFIG.targetChunkTokens,
      maxTokens: RAG_RETRIEVAL_CONFIG.maxChunkTokens,
      overlapTokens: RAG_RETRIEVAL_CONFIG.chunkOverlapTokens,
      semanticSimilarityThreshold:
        RAG_RETRIEVAL_CONFIG.semanticSimilarityThreshold,
      semanticEmbeddingBatchSize:
        RAG_RETRIEVAL_CONFIG.semanticEmbeddingBatchSize
    }
  );
  return annotateChunkOffsets(
    splitDocuments.map((splitDocument, index) => ({
      index,
      content: splitDocument.pageContent,
      charCount: splitDocument.pageContent.length,
      startChar: 0,
      endChar: 0,
      sourceType:
        getChunkSourceType(splitDocument.metadata, document.fileType),
      pageNumber: getDocumentPageNumber(splitDocument.metadata),
      blockIndex:
        getOriginalBlockIndexes(splitDocument.metadata)[0] ?? index,
      locator: "",
      tokenCount: getNonNegativeNumber(splitDocument.metadata.tokenCount),
      splitStrategy:
        typeof splitDocument.metadata.splitStrategy === "string"
          ? splitDocument.metadata.splitStrategy
          : "character",
      parentBlockIndexes: getOriginalBlockIndexes(splitDocument.metadata),
      chunkingVersion: RAG_CHUNKING_VERSION,
      blockType:
        typeof splitDocument.metadata.blockType === "string"
          ? splitDocument.metadata.blockType
          : undefined,
      sectionPath: Array.isArray(splitDocument.metadata.sectionPath)
        ? splitDocument.metadata.sectionPath.map(String)
        : undefined,
      boundingBox:
        splitDocument.metadata.bbox &&
        typeof splitDocument.metadata.bbox === "object" &&
        !Array.isArray(splitDocument.metadata.bbox)
          ? (splitDocument.metadata.bbox as Record<string, unknown>)
          : null,
      links: Array.isArray(splitDocument.metadata.links)
        ? splitDocument.metadata.links.map(String)
        : undefined
    })),
    document.text,
    document.fileType,
    sourceDocuments
  );
}

function getChunkSourceType(
  metadata: Record<string, unknown>,
  fileType: UploadedFileType
): DocumentChunk["sourceType"] {
  const value = metadata.sourceType;
  if (
    value === "table" ||
    value === "image_ocr" ||
    value === "image_summary"
  ) {
    return value;
  }
  return getDefaultChunkSourceType(fileType);
}

function getDocumentPageNumber(metadata: Record<string, unknown>): number | null {
  const loc = metadata.loc;
  const value =
    loc && typeof loc === "object"
      ? (loc as { pageNumber?: unknown }).pageNumber
      : metadata.pageNumber;
  const pageNumber = Number(value);
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function annotateChunkOffsets(
  chunks: DocumentChunk[],
  sourceText: string,
  fileType: UploadedFileType,
  sourceDocuments: Document[]
): DocumentChunk[] {
  const pageRanges = buildPageRanges(sourceText);
  const sourceBlockRanges = buildSourceBlockRanges(sourceDocuments, sourceText);

  // 学习点：记录 chunk 在原文里的位置，后续可以做来源定位和文件预览。
  return chunks.map((chunk) => {
    const parentRanges = chunk.parentBlockIndexes
      .map((blockIndex) => sourceBlockRanges.get(blockIndex))
      .filter(
        (
          range
        ): range is { startChar: number; endChar: number } => Boolean(range)
      );
    const rangeStart = parentRanges.length
      ? Math.min(...parentRanges.map((range) => range.startChar))
      : 0;
    const rangeEnd = parentRanges.length
      ? Math.max(...parentRanges.map((range) => range.endChar))
      : sourceText.length;
    const exactStart = sourceText.indexOf(chunk.content, rangeStart);
    const hasExactMatch =
      exactStart >= rangeStart && exactStart + chunk.content.length <= rangeEnd;
    // 表格分块会重复表头，因此无法总是逐字匹配；此时回退到原始结构块范围。
    const startChar = hasExactMatch ? exactStart : rangeStart;
    const endChar = hasExactMatch
      ? exactStart + chunk.content.length
      : rangeEnd;
    const pageNumber = chunk.pageNumber ?? findPageNumber(pageRanges, startChar);

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
        parentBlockIndexes: chunk.parentBlockIndexes,
        startChar,
        endChar
      })
    };
  });
}

function buildSourceBlockRanges(
  sourceDocuments: Document[],
  sourceText: string
): Map<number, { startChar: number; endChar: number }> {
  const ranges = new Map<number, { startChar: number; endChar: number }>();
  let searchFrom = 0;

  sourceDocuments.forEach((document, fallbackIndex) => {
    const blockIndex =
      getOriginalBlockIndexes(document.metadata)[0] ?? fallbackIndex;
    const content = document.pageContent.trim();
    const exactStart = sourceText.indexOf(content, searchFrom);
    const startChar = exactStart >= 0 ? exactStart : searchFrom;
    const endChar = Math.min(startChar + content.length, sourceText.length);
    ranges.set(blockIndex, { startChar, endChar });
    searchFrom = Math.max(endChar, searchFrom);
  });

  return ranges;
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
  parentBlockIndexes: number[];
  startChar: number;
  endChar: number;
}): string {
  // 学习点：locator 是给“定位/预览/后续修改”用的稳定描述。
  // 为什么这样：只靠 chunk 文本很容易在文档更新后找错段落，至少要保存页码/块序号/字符范围。
  const parts = [
    `type=${input.sourceType}`,
    input.pageNumber ? `page=${input.pageNumber}` : `page=unknown`,
    `block=${input.blockIndex}`,
    `parents=${input.parentBlockIndexes.join(",") || input.blockIndex}`,
    `version=${RAG_CHUNKING_VERSION}`,
    `chars=${input.startChar}-${input.endChar}`,
    `fileType=${input.fileType}`
  ];

  return parts.join("; ");
}

function getOriginalBlockIndexes(metadata: Record<string, unknown>): number[] {
  if (!Array.isArray(metadata.originalBlockIndexes)) {
    const documentIndex = Number(metadata.documentIndex);
    return Number.isInteger(documentIndex) && documentIndex >= 0
      ? [documentIndex]
      : [];
  }

  return metadata.originalBlockIndexes
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0);
}

function getNonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
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
    (fileType === "presentation" && [".ppt", ".pptx"].includes(extension)) ||
    (fileType === "word" && [".doc", ".docx"].includes(extension)) ||
    fileType === "spreadsheet" ||
    fileType === "html" ||
    fileType === "image"
  );
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
