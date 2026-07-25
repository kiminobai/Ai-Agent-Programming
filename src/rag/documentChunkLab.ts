import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { UploadedDocumentRecord } from "./uploadedDocumentStore";

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

export interface RetrievedDocumentChunk extends DocumentChunk {
  score: number;
  matchedTerms: string[];
}

export interface UploadedDocumentRetrievalResult {
  fileName: string;
  fileType: "markdown" | "pdf" | "text";
  totalCharacters: number;
  totalChunkCount: number;
  returnedChunkCount: number;
  retrievalStrategy: "keyword-overlap";
  query: string;
  chunks: RetrievedDocumentChunk[];
}

/**
 * Parses the uploaded file once and stores normalized plain text on the thread.
 * Retrieval happens later, only when the Agent decides it needs document
 * content for the user's request.
 */
export async function createUploadedDocumentRecord(input: {
  threadId: string;
  userId: string;
  fileName: string;
  fileBuffer: Buffer;
}): Promise<UploadedDocumentRecord> {
  const fileType = getFileType(getExtension(input.fileName));
  const text = normalizeText(
    await extractTextFromUpload(input.fileBuffer, fileType)
  );

  if (!text) {
    throw new Error("The uploaded document did not contain readable text.");
  }

  return {
    threadId: input.threadId,
    userId: input.userId,
    fileName: input.fileName,
    fileType,
    text,
    uploadedAt: new Date().toISOString()
  };
}

/**
 * Retrieves the most relevant chunks for the current user task.
 *
 * This is the actual context-control step for RAG: chunk all text internally,
 * score chunks against the user's query, then return only Top-K chunks.
 */
export async function retrieveUploadedDocumentChunks(
  document: UploadedDocumentRecord,
  query: string
): Promise<UploadedDocumentRetrievalResult> {
  const allChunks = await splitDocumentText(document);
  const queryTerms = extractQueryTerms(query);
  const scoredChunks = allChunks.map((chunk) => scoreChunk(chunk, query, queryTerms));
  const hasUsefulMatch = scoredChunks.some((chunk) => chunk.score > 0);
  const rankedChunks = [...scoredChunks].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.index - right.index;
  });

  const selectedChunks = (hasUsefulMatch ? rankedChunks : scoredChunks)
    .slice(0, RAG_RETRIEVAL_CONFIG.topK)
    .sort((left, right) => left.index - right.index)
    .map((chunk) => ({
      ...chunk,
      content: truncateChunk(chunk.content)
    }));

  return {
    fileName: document.fileName,
    fileType: document.fileType,
    totalCharacters: document.text.length,
    totalChunkCount: allChunks.length,
    returnedChunkCount: selectedChunks.length,
    retrievalStrategy: "keyword-overlap",
    query,
    chunks: selectedChunks
  };
}

async function splitDocumentText(
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

function scoreChunk(
  chunk: DocumentChunk,
  rawQuery: string,
  queryTerms: string[]
): RetrievedDocumentChunk {
  const normalizedContent = chunk.content.toLowerCase();
  const normalizedQuery = rawQuery.trim().toLowerCase();
  const matchedTerms = queryTerms.filter((term) => normalizedContent.includes(term));
  const uniqueMatchedTerms = [...new Set(matchedTerms)];
  const exactPhraseBoost =
    normalizedQuery.length >= 4 && normalizedContent.includes(normalizedQuery) ? 8 : 0;
  const headingBoost = /^#{1,6}\s/m.test(chunk.content) ? 1 : 0;

  return {
    ...chunk,
    score: uniqueMatchedTerms.length * 3 + exactPhraseBoost + headingBoost,
    matchedTerms: uniqueMatchedTerms
  };
}

function extractQueryTerms(query: string): string[] {
  const normalizedQuery = query.toLowerCase();
  const latinTerms = normalizedQuery.match(/[a-z0-9_+-]{2,}/g) ?? [];
  const cjkText = normalizedQuery.replace(/[^\u4e00-\u9fff]/g, "");
  const cjkTerms: string[] = [];

  for (let index = 0; index < cjkText.length - 1; index += 1) {
    cjkTerms.push(cjkText.slice(index, index + 2));
  }

  return [...new Set([...latinTerms, ...cjkTerms])].slice(
    0,
    RAG_RETRIEVAL_CONFIG.maxQueryTerms
  );
}

function truncateChunk(content: string): string {
  if (content.length <= RAG_RETRIEVAL_CONFIG.maxChunkCharacters) {
    return content;
  }

  return `${content.slice(0, RAG_RETRIEVAL_CONFIG.maxChunkCharacters)}...(truncated)`;
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

function getFileType(extension: string): "markdown" | "pdf" | "text" {
  if (extension === ".pdf") {
    return "pdf";
  }

  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }

  if (extension === ".txt") {
    return "text";
  }

  throw new Error("Only .md, .markdown, .txt, and .pdf files are supported.");
}

async function extractTextFromUpload(
  fileBuffer: Buffer,
  fileType: "markdown" | "pdf" | "text"
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

function getSeparators(fileType: "markdown" | "pdf" | "text"): string[] {
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
