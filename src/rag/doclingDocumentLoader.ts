import { Document } from "@langchain/core/documents";
import type { DocumentLoader } from "@langchain/core/document_loaders/base";
import { appConfig } from "../config";

type JsonObject = Record<string, unknown>;

type DoclingConversionResponse = {
  status?: string;
  document?: {
    md_content?: string;
    json_content?: JsonObject | string;
  };
  errors?: unknown[];
};

type StructureContext = {
  sectionPath: string[];
  level: number;
};

/**
 * 学习点：Docling 是“版面解析服务”，LangChain Document 是项目内部标准。
 *
 * 为什么分两层：Docling 擅长识别标题、段落、表格、图片和坐标；
 * LangChain 负责后续切分、Embedding 与检索。解析器可以替换，RAG 后半段不用改。
 */
export class DoclingDocumentLoader implements DocumentLoader {
  constructor(
    private readonly input: {
      fileName: string;
      mimeType: string;
      fileBuffer: Buffer;
    }
  ) {}

  async load(): Promise<Document[]> {
    const response = await convertWithDocling(this.input);
    const jsonContent = parseJsonContent(response.document?.json_content);
    const documents = jsonContent
      ? extractStructuredDocuments(jsonContent)
      : [];

    if (documents.length > 0) {
      return documents;
    }

    // JSON 是结构保真来源；旧版服务没有返回 JSON 时，用 Markdown 保留标题和表格。
    const markdown = response.document?.md_content?.trim();
    if (markdown) {
      return [
        new Document({
          pageContent: markdown,
          metadata: {
            blockType: "document",
            sourceType: "text",
            structureFormat: "markdown"
          }
        })
      ];
    }

    throw new Error("Docling 没有返回可解析的文档内容。");
  }
}

async function convertWithDocling(input: {
  fileName: string;
  mimeType: string;
  fileBuffer: Buffer;
}): Promise<DoclingConversionResponse> {
  const form = new FormData();
  form.append(
    "files",
    new Blob([new Uint8Array(input.fileBuffer)], {
      type: input.mimeType || "application/pdf"
    }),
    input.fileName
  );
  // 不指定 from_formats，让 Docling 根据文件名和内容自动识别 PDF、DOCX、
  // XLSX、PPTX、HTML 等格式。这里写死为 pdf 会让所有 Office 增强解析失败。
  form.append("to_formats", "md");
  form.append("to_formats", "json");
  form.append("do_ocr", "true");
  form.append("table_mode", "accurate");
  form.append("image_export_mode", "placeholder");

  if (appConfig.documentParser.describePictures) {
    // 图片描述由 Docling 本地模型完成，不会偷偷调用当前聊天模型。
    form.append("do_picture_description", "true");
  }

  const headers: Record<string, string> = {};
  if (appConfig.documentParser.doclingApiKey) {
    headers["X-Api-Key"] = appConfig.documentParser.doclingApiKey;
  }

  const response = await fetch(
    `${appConfig.documentParser.doclingUrl.replace(/\/$/, "")}/v1/convert/file`,
    {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(appConfig.documentParser.timeoutMs)
    }
  );

  if (!response.ok) {
    throw new Error(`Docling 请求失败：HTTP ${response.status}`);
  }

  const result = (await response.json()) as DoclingConversionResponse;
  if (!["success", "partial_success"].includes(result.status || "")) {
    throw new Error(`Docling 转换失败：${JSON.stringify(result.errors || [])}`);
  }

  return result;
}

function parseJsonContent(value: JsonObject | string | undefined): JsonObject | null {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractStructuredDocuments(root: JsonObject): Document[] {
  const output: Document[] = [];
  const initialContext: StructureContext = { sectionPath: [], level: 0 };
  const body = isObject(root.body) ? root.body : null;

  if (body) {
    walkNode(root, body, initialContext, output, new Set<string>());
  }

  // 容错：个别 Docling 版本可能没有 body 树，仍按顶层数组保留内容。
  if (output.length === 0) {
    for (const collectionName of ["texts", "tables", "pictures"]) {
      const items = Array.isArray(root[collectionName]) ? root[collectionName] : [];
      for (const item of items) {
        if (isObject(item)) {
          appendContentDocument(item, initialContext, output);
        }
      }
    }
  }

  return output;
}

function walkNode(
  root: JsonObject,
  node: JsonObject,
  context: StructureContext,
  output: Document[],
  visited: Set<string>
): void {
  const reference = getReference(node);
  if (reference) {
    if (visited.has(reference)) {
      return;
    }
    visited.add(reference);
    const resolved = resolveJsonPointer(root, reference);
    if (resolved) {
      walkNode(root, resolved, context, output, visited);
    }
    return;
  }

  const nextContext = appendContentDocument(node, context, output);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (isObject(child)) {
      walkNode(root, child, nextContext, output, visited);
    }
  }
}

function appendContentDocument(
  item: JsonObject,
  context: StructureContext,
  output: Document[]
): StructureContext {
  const label = String(item.label || item.type || "").toLowerCase();
  const pageNumber = getPageNumber(item);
  const bbox = getBoundingBox(item);

  if (["title", "section_header"].includes(label)) {
    const text = getText(item);
    if (!text) {
      return context;
    }
    const headingLevel = getHeadingLevel(item, context.level);
    const sectionPath = [
      ...context.sectionPath.slice(0, Math.max(headingLevel - 1, 0)),
      text
    ];
    output.push(
      makeDocument(text, {
        blockType: "heading",
        sourceType: "text",
        headingLevel,
        sectionPath,
        pageNumber,
        bbox
      })
    );
    return { sectionPath, level: headingLevel };
  }

  if (label === "table" || isObject(item.data)) {
    const table = renderTable(item);
    if (table.markdown) {
      output.push(
        makeDocument(withSectionContext(table.markdown, context.sectionPath), {
          blockType: "table",
          sourceType: "table",
          sectionPath: context.sectionPath,
          pageNumber,
          bbox,
          tableHtml: table.html,
          tableCells: table.cells
        })
      );
    }
    return context;
  }

  if (["picture", "image", "chart"].includes(label)) {
    const description = getPictureDescription(item);
    if (description) {
      output.push(
        makeDocument(withSectionContext(description, context.sectionPath), {
          blockType: label === "chart" ? "chart" : "image",
          sourceType: "image_summary",
          sectionPath: context.sectionPath,
          pageNumber,
          bbox
        })
      );
    }
    return context;
  }

  const text = getText(item);
  if (text) {
    output.push(
      makeDocument(withSectionContext(text, context.sectionPath), {
        blockType: label || "paragraph",
        sourceType: "text",
        sectionPath: context.sectionPath,
        pageNumber,
        bbox,
        links: findLinks(item)
      })
    );
  }
  return context;
}

function makeDocument(
  pageContent: string,
  metadata: Record<string, unknown>
): Document {
  return new Document({
    pageContent,
    metadata: {
      ...metadata,
      structureFormat: "docling-json"
    }
  });
}

function withSectionContext(content: string, sectionPath: string[]): string {
  return sectionPath.length
    ? `章节：${sectionPath.join(" > ")}\n${content}`
    : content;
}

function renderTable(item: JsonObject): {
  markdown: string;
  html: string;
  cells: JsonObject[];
} {
  const data = isObject(item.data) ? item.data : {};
  const cells = Array.isArray(data.table_cells)
    ? data.table_cells.filter(isObject)
    : [];
  if (cells.length === 0) {
    const fallback = getText(item);
    return { markdown: fallback, html: "", cells: [] };
  }

  const rowCount = Math.max(
    Number(data.num_rows || 0),
    ...cells.map((cell) => Number(cell.end_row_offset_idx || 0))
  );
  const columnCount = Math.max(
    Number(data.num_cols || 0),
    ...cells.map((cell) => Number(cell.end_col_offset_idx || 0))
  );
  const grid = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => "")
  );

  for (const cell of cells) {
    const row = Number(cell.start_row_offset_idx || 0);
    const column = Number(cell.start_col_offset_idx || 0);
    if (grid[row]?.[column] !== undefined) {
      grid[row][column] = String(cell.text || "").trim();
    }
  }

  const markdown = grid.length
    ? [
        `| ${grid[0].map(escapeMarkdownCell).join(" | ")} |`,
        `| ${grid[0].map(() => "---").join(" | ")} |`,
        ...grid.slice(1).map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`)
      ].join("\n")
    : "";
  const html = `<table>${grid
    .map(
      (row, rowIndex) =>
        `<tr>${row
          .map((value) =>
            rowIndex === 0
              ? `<th>${escapeHtml(value)}</th>`
              : `<td>${escapeHtml(value)}</td>`
          )
          .join("")}</tr>`
    )
    .join("")}</table>`;

  return { markdown, html, cells };
}

function getText(item: JsonObject): string {
  return String(item.text || item.orig || "").trim();
}

function getPictureDescription(item: JsonObject): string {
  const candidates = [
    item.description,
    item.text,
    ...(Array.isArray(item.annotations) ? item.annotations : [])
  ];
  const descriptions = candidates
    .flatMap((candidate) => collectStrings(candidate))
    .filter((value) => value.length > 2 && !value.startsWith("#/"));
  return descriptions.length ? `图片说明：${[...new Set(descriptions)].join("；")}` : "";
}

function getHeadingLevel(item: JsonObject, parentLevel: number): number {
  const explicit = Number(item.level);
  return Number.isInteger(explicit) && explicit > 0
    ? explicit
    : Math.max(parentLevel + 1, 1);
}

function getPageNumber(item: JsonObject): number | null {
  const provenance = Array.isArray(item.prov) ? item.prov.find(isObject) : null;
  const pageNumber = Number(provenance?.page_no || item.page_no || 0);
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function getBoundingBox(item: JsonObject): JsonObject | null {
  const provenance = Array.isArray(item.prov) ? item.prov.find(isObject) : null;
  return provenance && isObject(provenance.bbox) ? provenance.bbox : null;
}

function findLinks(item: JsonObject): string[] {
  return [
    ...new Set(
      collectStrings(item).flatMap((value) =>
        value.match(/https?:\/\/[^\s<>"')\]]+/g) || []
      )
    )
  ];
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (isObject(value)) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function getReference(node: JsonObject): string | null {
  const value = node.$ref || node.cref || node.ref;
  return typeof value === "string" && value.startsWith("#/") ? value : null;
}

function resolveJsonPointer(root: JsonObject, pointer: string): JsonObject | null {
  const value = pointer
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (Array.isArray(current)) {
        return current[Number(segment)];
      }
      return isObject(current) ? current[segment] : undefined;
    }, root);
  return isObject(value) ? value : null;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
