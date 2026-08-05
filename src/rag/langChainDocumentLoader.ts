import { Document } from "@langchain/core/documents";
import type { DocumentLoader } from "@langchain/core/document_loaders/base";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { PPTXLoader } from "@langchain/community/document_loaders/fs/pptx";
import { HTMLWebBaseLoader } from "@langchain/community/document_loaders/web/html";
import JSZip from "jszip";
import { appConfig } from "../config";
import { DoclingDocumentLoader } from "./doclingDocumentLoader";
import { extractTextFromImage } from "./imageOcrExtractor";
import {
  extractTextFromHtml,
  extractTextFromSpreadsheet
} from "./officeTextExtractor";
import { extractTextFromPptx } from "./pptxTextExtractor";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";

export type LangChainDocumentMetadata = Record<string, unknown>;

export type StoredLangChainDocument = {
  pageContent: string;
  metadata: LangChainDocumentMetadata;
};

type UploadLoaderInput = {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileBuffer: Buffer;
  fileType: UploadedDocumentRecord["fileType"];
};

/**
 * 学习点：所有文件格式必须先转换为 LangChain Document[]。
 *
 * 为什么这样：后续 Splitter、Embedding、Retriever 只依赖统一的
 * pageContent + metadata，不需要继续判断 PDF、Word 或表格格式。
 */
export async function loadUploadedDocuments(
  input: UploadLoaderInput
): Promise<Document[]> {
  const extension = getExtension(input.fileName);
  const blob = toBlob(input.fileBuffer, input.mimeType);
  let loader: DocumentLoader;
  let loaderName: string;

  if (input.fileType === "pdf") {
    // 第一步永远先走 LangChain PDFLoader，普通文字 PDF 到这里即可完成。
    const baseDocuments = await loadBaseDocuments(
      new PDFLoader(blob, { splitPages: true }),
      input.fileName
    );
    if (
      appConfig.documentParser.provider === "docling" &&
      shouldEnhancePdf(input.fileBuffer, baseDocuments)
    ) {
      try {
        const documents = await new DoclingDocumentLoader({
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileBuffer: input.fileBuffer
        }).load();
        return attachCommonMetadata(documents, input, "DoclingDocumentLoader");
      } catch (error) {
        // 第二步增强失败不覆盖第一步结果，避免专业解析服务成为单点故障。
        console.warn("Docling parsing failed, falling back to PDFLoader:", error);
      }
    }
    return attachCommonMetadata(baseDocuments, input, "PDFLoader");
  } else if (input.fileType === "markdown" || input.fileType === "text") {
    loader = new TextLoader(blob);
    loaderName = "TextLoader";
  } else if (extension === ".csv") {
    loader = new CSVLoader(blob);
    loaderName = "CSVLoader";
  } else if (input.fileType === "word" && [".doc", ".docx"].includes(extension)) {
    const baseDocuments = await loadBaseDocuments(
      new DocxLoader(blob, {
        type: extension === ".doc" ? "doc" : "docx"
      }),
      input.fileName
    );
    const enhancedDocuments = await tryDoclingEnhancement(
      input,
      await shouldEnhanceOfficeDocument(input.fileBuffer, extension, baseDocuments)
    );
    return attachCommonMetadata(
      enhancedDocuments || baseDocuments,
      input,
      enhancedDocuments ? "DoclingDocumentLoader" : "DocxLoader"
    );
  } else if (input.fileType === "presentation" && extension === ".pptx") {
    // LangChain PPTXLoader 是基础读取器；复杂版面优先交给 Docling。
    const baseDocuments = await loadBaseDocuments(
      new PPTXLoader(blob),
      input.fileName
    );
    const shouldEnhance = await shouldEnhanceOfficeDocument(
      input.fileBuffer,
      extension,
      baseDocuments
    );
    const doclingDocuments = await tryDoclingEnhancement(input, shouldEnhance);
    if (doclingDocuments) {
      return attachCommonMetadata(
        doclingDocuments,
        input,
        "DoclingDocumentLoader"
      );
    }

    if (shouldEnhance) {
      try {
        const enhancedDocuments = await createEnhancedDocumentLoader(
          input,
          extension
        ).load();
        if (hasUsefulDocuments(enhancedDocuments)) {
          return attachCommonMetadata(
            enhancedDocuments,
            input,
            "EnhancedPptxDocumentLoader"
          );
        }
      } catch (error) {
        console.warn(
          "Enhanced PPTX parsing failed, falling back to PPTXLoader:",
          error
        );
      }
    }
    return attachCommonMetadata(baseDocuments, input, "PPTXLoader");
  } else if (
    input.fileType === "presentation" &&
    extension === ".ppt"
  ) {
    // 旧版 PPT 没有可靠的轻量 Loader，只能交给带 LibreOffice 的 Docling。
    const documents = await tryDoclingEnhancement(input, true);
    return attachCommonMetadata(
      documents || [],
      input,
      "DoclingDocumentLoader"
    );
  } else if (input.fileType === "spreadsheet") {
    const baseDocuments = await loadBaseDocuments(
      createEnhancedDocumentLoader(input, extension),
      input.fileName
    );
    const enhancedDocuments = await tryDoclingEnhancement(
      input,
      await shouldEnhanceOfficeDocument(input.fileBuffer, extension, baseDocuments)
    );
    return attachCommonMetadata(
      enhancedDocuments || baseDocuments,
      input,
      enhancedDocuments
        ? "DoclingDocumentLoader"
        : "SpreadsheetDocumentLoader"
    );
  } else if (input.fileType === "html") {
    const baseDocuments = await loadBaseDocuments(
      createEnhancedDocumentLoader(input, extension),
      input.fileName
    );
    const enhancedDocuments = await tryDoclingEnhancement(
      input,
      shouldEnhanceHtml(input.fileBuffer, baseDocuments)
    );
    return attachCommonMetadata(
      enhancedDocuments || baseDocuments,
      input,
      enhancedDocuments ? "DoclingDocumentLoader" : "UploadedHtmlDocumentLoader"
    );
  } else {
    // LangChain 没有覆盖项目增强能力的格式，使用自定义 Loader，
    // 但仍遵守 DocumentLoader.load(): Promise<Document[]> 标准接口。
    loader = createEnhancedDocumentLoader(input, extension);
    loaderName = getEnhancedLoaderName(input.fileType);
  }

  return attachCommonMetadata(await loader.load(), input, loaderName);
}

async function loadBaseDocuments(
  loader: DocumentLoader,
  fileName: string
): Promise<Document[]> {
  try {
    return await loader.load();
  } catch (error) {
    // 基础读取失败不立即污染对话或终止上传，后续还可以由 Docling 尝试恢复。
    console.warn(`Base document loader failed for ${fileName}:`, error);
    return [];
  }
}

async function tryDoclingEnhancement(
  input: UploadLoaderInput,
  shouldEnhance: boolean
): Promise<Document[] | null> {
  if (
    !shouldEnhance ||
    appConfig.documentParser.provider !== "docling"
  ) {
    return null;
  }

  try {
    const documents = await new DoclingDocumentLoader({
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileBuffer: input.fileBuffer
    }).load();
    return hasUsefulDocuments(documents) ? documents : null;
  } catch (error) {
    // 增强服务异常时继续使用基础 Loader，避免 Docker 成为上传单点故障。
    console.warn(
      `Docling enhancement failed for ${input.fileName}, using base loader:`,
      error
    );
    return null;
  }
}

function shouldEnhancePdf(fileBuffer: Buffer, documents: Document[]): boolean {
  const totalCharacters = documents.reduce(
    (sum, document) => sum + document.pageContent.trim().length,
    0
  );
  const averageCharacters =
    documents.length > 0 ? totalCharacters / documents.length : 0;
  const pdfSource = fileBuffer.toString("latin1");
  const imageCount = pdfSource.match(/\/Subtype\s*\/Image\b/g)?.length || 0;
  const hasTaggedTable =
    /\/S\s*\/Table\b/.test(pdfSource) || /<Table\b/i.test(pdfSource);
  const extractedText = documents.map((document) => document.pageContent).join("\n");
  const hasTableLikeRows =
    (extractedText.match(/\S[ \t]{3,}\S/g)?.length || 0) >= 3;

  // 空文本、扫描页、图片、表格或每页文字极少，都说明基础读取可能丢失版面信息。
  return (
    documents.length === 0 ||
    averageCharacters < 80 ||
    imageCount > 0 ||
    hasTaggedTable ||
    hasTableLikeRows
  );
}

function hasUsefulDocuments(documents: Document[]): boolean {
  return documents.some((document) => document.pageContent.trim().length > 0);
}

async function shouldEnhanceOfficeDocument(
  fileBuffer: Buffer,
  extension: string,
  documents: Document[]
): Promise<boolean> {
  // 旧版二进制 Office 需要 LibreOffice 转换，直接交给 Docling 尝试。
  if ([".doc", ".xls", ".ppt"].includes(extension)) {
    return true;
  }

  const totalCharacters = documents.reduce(
    (sum, document) => sum + document.pageContent.trim().length,
    0
  );
  if (documents.length === 0 || totalCharacters < 40) {
    return true;
  }

  if (![".docx", ".xlsx", ".pptx"].includes(extension)) {
    return false;
  }

  try {
    const zip = await JSZip.loadAsync(fileBuffer);
    const fileNames = Object.keys(zip.files);
    const prefixes: Record<string, string[]> = {
      ".docx": [
        "word/media/",
        "word/charts/",
        "word/embeddings/",
        "word/comments",
        "word/footnotes"
      ],
      ".xlsx": [
        "xl/media/",
        "xl/charts/",
        "xl/drawings/",
        "xl/tables/",
        "xl/comments",
        "xl/externalLinks/"
      ],
      ".pptx": [
        "ppt/media/",
        "ppt/charts/",
        "ppt/embeddings/"
      ]
    };
    if (
      (prefixes[extension] || []).some((prefix) =>
        fileNames.some((fileName) => fileName.startsWith(prefix))
      )
    ) {
      return true;
    }

    const xmlPaths = fileNames.filter((fileName) => {
      if (extension === ".docx") {
        return fileName === "word/document.xml";
      }
      if (extension === ".xlsx") {
        return /^xl\/worksheets\/sheet\d+\.xml$/.test(fileName);
      }
      return /^ppt\/slides\/slide\d+\.xml$/.test(fileName);
    });
    const xmlContents = await Promise.all(
      xmlPaths.map((fileName) => zip.files[fileName].async("text"))
    );
    return xmlContents.some((xml) =>
      /<(?:w:tbl|w:hyperlink|w:drawing|hyperlink|drawing|a:tbl|a:hlinkClick|p:graphicFrame)\b/i.test(
        xml
      )
    );
  } catch {
    // OOXML 文件无法打开通常意味着文件损坏；让 Docling 再尝试一次更稳妥。
    return true;
  }
}

function shouldEnhanceHtml(
  fileBuffer: Buffer,
  documents: Document[]
): boolean {
  const html = fileBuffer.toString("utf8");
  return (
    !hasUsefulDocuments(documents) ||
    /<(?:table|img|picture|figure|svg|canvas|a)\b/i.test(html)
  );
}

function attachCommonMetadata(
  documents: Document[],
  input: UploadLoaderInput,
  loaderName: string
): Document[] {
  return documents
    .filter((document) => Boolean(document.pageContent.trim()))
    .map(
      (document, index) =>
        new Document({
          pageContent: normalizeText(document.pageContent),
          metadata: {
            ...document.metadata,
            source: input.fileName,
            fileId: input.fileId,
            fileName: input.fileName,
            mimeType: input.mimeType,
            fileType: input.fileType,
            loader: loaderName,
            documentIndex: index
          }
        })
    );
}

/**
 * WebBaseLoader 专门读取 URL，不和“用户上传 HTML 文件”混用。
 * 后续增加网页知识源时可直接复用这个入口。
 */
export async function loadWebDocuments(url: string): Promise<Document[]> {
  const loader = new HTMLWebBaseLoader(url);
  const documents = await loader.load();
  return documents.map(
    (document, index) =>
      new Document({
        pageContent: normalizeText(document.pageContent),
        metadata: {
          ...document.metadata,
          source: url,
          loader: "HTMLWebBaseLoader",
          documentIndex: index
        }
      })
  );
}

export function storeLangChainDocuments(
  documents: Document[]
): StoredLangChainDocument[] {
  return documents.map((document) => ({
    pageContent: document.pageContent,
    metadata: document.metadata
  }));
}

export function restoreLangChainDocuments(
  documents: StoredLangChainDocument[]
): Document[] {
  return documents.map(
    (document) =>
      new Document({
        pageContent: document.pageContent,
        metadata: document.metadata
      })
  );
}

export function renderDocumentsAsStoredText(documents: Document[]): string {
  return documents
    .map((document, index) => {
      const pageNumber = getPageNumber(document.metadata);
      if (pageNumber) {
        return `[PDF_PAGE:${pageNumber}]\n${document.pageContent}`;
      }

      const rowNumber = getPositiveNumber(document.metadata.line);
      if (document.metadata.loader === "CSVLoader" && rowNumber) {
        return `[CSV_ROW:${rowNumber}]\n${document.pageContent}`;
      }

      return document.pageContent || `[Empty document ${index + 1}]`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function createEnhancedDocumentLoader(
  input: UploadLoaderInput,
  extension: string
): DocumentLoader {
  return {
    async load(): Promise<Document[]> {
      if (input.fileType === "presentation" && extension === ".pptx") {
        return splitMarkerDocuments(
          await extractTextFromPptx(input.fileBuffer),
          /^\[Slide (\d+)\]$/gm,
          "slideNumber"
        );
      }

      if (input.fileType === "spreadsheet") {
        return splitMarkerDocuments(
          extractTextFromSpreadsheet(input.fileBuffer),
          /^\[Sheet: ([^\]]+)\]$/gm,
          "sheetName"
        );
      }

      if (input.fileType === "html") {
        return [
          new Document({
            pageContent: extractTextFromHtml(input.fileBuffer),
            metadata: {}
          })
        ];
      }

      if (input.fileType === "image") {
        return [
          new Document({
            pageContent: await extractTextFromImage(input.fileBuffer),
            metadata: { sourceType: "image_ocr" }
          })
        ];
      }

      return [
        new Document({
          pageContent: input.fileBuffer.toString("utf8"),
          metadata: {}
        })
      ];
    }
  };
}

function splitMarkerDocuments(
  text: string,
  markerPattern: RegExp,
  metadataKey: "slideNumber" | "sheetName"
): Document[] {
  const matches = [...text.matchAll(markerPattern)];
  if (!matches.length) {
    return [new Document({ pageContent: text, metadata: {} })];
  }

  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = matches[index + 1]?.index ?? text.length;
    const rawValue = match[1];
    return new Document({
      pageContent: text.slice(start, end).trim(),
      metadata: {
        [metadataKey]:
          metadataKey === "slideNumber" ? Number(rawValue) : rawValue
      }
    });
  });
}

function getPageNumber(metadata: LangChainDocumentMetadata): number | null {
  const loc = metadata.loc;
  if (loc && typeof loc === "object") {
    const pageNumber = getPositiveNumber((loc as { pageNumber?: unknown }).pageNumber);
    if (pageNumber) {
      return pageNumber;
    }
  }

  return getPositiveNumber(metadata.pageNumber);
}

function getPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

function getEnhancedLoaderName(
  fileType: UploadedDocumentRecord["fileType"]
): string {
  const names: Partial<Record<UploadedDocumentRecord["fileType"], string>> = {
    presentation: "EnhancedPptxDocumentLoader",
    spreadsheet: "SpreadsheetDocumentLoader",
    html: "UploadedHtmlDocumentLoader",
    image: "ImageTextDocumentLoader"
  };
  return names[fileType] || "BinaryDocumentLoader";
}

function toBlob(fileBuffer: Buffer, mimeType: string): Blob {
  return new Blob([new Uint8Array(fileBuffer)], {
    type: mimeType || "application/octet-stream"
  });
}

function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
