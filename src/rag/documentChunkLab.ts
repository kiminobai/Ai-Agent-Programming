import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";

/**
 * Backend-owned RAG policy.
 *
 * Uploading a file only stores normalized text on the current thread. When the
 * user asks a file-related question, the Agent retrieves a few relevant chunks
 * instead of pushing the whole document into the model context.
 */
export const RAG_RETRIEVAL_CONFIG = {
  chunkSize: 800,
  chunkOverlap: 120,
  topK: 4,
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
  | "image"
  | "binary";

/**
 * Parses the uploaded file once and stores normalized plain text on the thread.
 * Retrieval happens later, only when the Agent decides it needs document
 * content for the user's request.
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
  const fileType = getFileType(getExtension(input.fileName));
  const canParseText =
    fileType === "markdown" || fileType === "pdf" || fileType === "text";
  const text = canParseText
    ? normalizeText(await extractTextFromUpload(input.fileBuffer, fileType))
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
  fileType: UploadedFileType
): Promise<string> {
  if (fileType === "pdf") {
    const parser = new PDFParse({ data: new Uint8Array(fileBuffer) });

    try {
      const parsed = await parser.getText();
      return parsed.text || "";
    } finally {
      await parser.destroy();
    }
  }

  return fileBuffer.toString("utf8");
}

function getSeparators(fileType: UploadedFileType): string[] {
  if (fileType === "markdown") {
    return ["\n# ", "\n## ", "\n### ", "\n\n", "\n", "。", "！", "？", ". ", " ", ""];
  }

  return ["\n\n", "\n", "。", "！", "？", ". ", " ", ""];
}

function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
