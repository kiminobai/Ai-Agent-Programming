import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { getEncoding } from "js-tiktoken";
import { embeddingProvider } from "./embeddingProvider";

type ChunkSourceType = "text" | "table" | "image_ocr" | "image_summary";

export type StructuredChunkerConfig = {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  semanticSimilarityThreshold: number;
  semanticEmbeddingBatchSize: number;
};

type StructuralUnit = {
  content: string;
  metadata: Record<string, unknown>;
  sourceType: ChunkSourceType;
  tokenCount: number;
};

// cl100k_base 只负责稳定计算 Token 预算，不参与模型生成。
// 不同厂商模型的实际 Token 数可能略有差异，因此 maxTokens 要保留安全余量。
const tokenEncoding = getEncoding("cl100k_base");

/**
 * 学习点：复杂文档切分不是只选一种算法，而是分层组合。
 *
 * 1. 结构层：标题跟随正文，表格和图片保持独立。
 * 2. 语义层：相邻正文向量足够相似时才合并。
 * 3. Token 层：任何 chunk 都不能超过模型上下文预算。
 * 4. 字符层：超长块最后按段落、句子和字符递归切开。
 */
export async function splitDocumentsWithStructure(
  documents: Document[],
  fileType: string,
  config: StructuredChunkerConfig
): Promise<Document[]> {
  const structuralUnits = createStructuralUnits(documents, fileType);
  const boundedUnits = (
    await Promise.all(
      structuralUnits.map((unit) => enforceTokenLimit(unit, fileType, config))
    )
  ).flat();
  const groupedUnits = await groupTextUnitsSemantically(boundedUnits, config);

  return groupedUnits.map(
    (unit) =>
      new Document({
        pageContent: unit.content,
        metadata: {
          ...unit.metadata,
          sourceType: unit.sourceType,
          tokenCount: unit.tokenCount
        }
      })
  );
}

function createStructuralUnits(
  documents: Document[],
  fileType: string
): StructuralUnit[] {
  const units: StructuralUnit[] = [];
  let pendingHeading: StructuralUnit | null = null;

  documents.forEach((document, fallbackIndex) => {
    const content = document.pageContent.trim();
    if (!content) {
      return;
    }

    const originalBlockIndex = getOriginalBlockIndex(
      document.metadata,
      fallbackIndex
    );
    const metadata: Record<string, unknown> = {
      ...document.metadata,
      originalBlockIndexes: [originalBlockIndex]
    };
    const sourceType = getSourceType(metadata, fileType);
    const blockType = String(metadata.blockType || "").toLowerCase();

    if (blockType === "heading") {
      // 标题暂存，等下一段正文到来时一起进入检索，避免生成无上下文的小 chunk。
      pendingHeading = makeUnit(content, metadata, "text", "structure-heading");
      return;
    }

    const contentWithHeading = pendingHeading
      ? prependHeading(pendingHeading.content, content)
      : content;
    const metadataWithHeading = pendingHeading
      ? mergeMetadata(pendingHeading.metadata, metadata)
      : metadata;
    pendingHeading = null;

    if (sourceType === "table") {
      units.push(
        makeUnit(
          contentWithHeading,
          metadataWithHeading,
          sourceType,
          "structure-table"
        )
      );
      return;
    }

    if (sourceType === "image_ocr" || sourceType === "image_summary") {
      // 图片说明是一个完整语义单元，不与前后普通段落进行 overlap。
      units.push(
        makeUnit(
          contentWithHeading,
          metadataWithHeading,
          sourceType,
          "structure-image"
        )
      );
      return;
    }

    const paragraphs = splitNaturalParagraphs(contentWithHeading);
    paragraphs.forEach((paragraph) => {
      units.push(
        makeUnit(
          paragraph,
          metadataWithHeading,
          "text",
          "structure-paragraph"
        )
      );
    });
  });

  if (pendingHeading) {
    units.push(pendingHeading);
  }

  return units;
}

async function enforceTokenLimit(
  unit: StructuralUnit,
  fileType: string,
  config: StructuredChunkerConfig
): Promise<StructuralUnit[]> {
  if (unit.sourceType === "table") {
    const tableUnits = splitMarkdownTable(unit, config.maxTokens);
    const boundedTableUnits: StructuralUnit[] = [];
    for (const tableUnit of tableUnits) {
      if (tableUnit.tokenCount <= config.maxTokens) {
        boundedTableUnits.push(tableUnit);
      } else {
        boundedTableUnits.push(
          ...(await splitUnitRecursively(tableUnit, fileType, config))
        );
      }
    }
    return boundedTableUnits;
  }

  if (unit.tokenCount <= config.maxTokens) {
    return [unit];
  }

  return splitUnitRecursively(unit, fileType, config);
}

async function splitUnitRecursively(
  unit: StructuralUnit,
  fileType: string,
  config: StructuredChunkerConfig
): Promise<StructuralUnit[]> {
  // 字符分隔符决定在哪里切，lengthFunction 则确保每块按 Token 而非字符计量。
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.maxTokens,
    chunkOverlap:
      unit.sourceType === "text" ? config.overlapTokens : 0,
    separators: getCharacterSeparators(fileType),
    lengthFunction: countTokens
  });
  const splitDocuments = await splitter.splitDocuments([
    new Document({
      pageContent: unit.content,
      metadata: unit.metadata
    })
  ]);

  return splitDocuments.map((document) =>
    makeUnit(
      document.pageContent,
      document.metadata,
      unit.sourceType,
      "token-character-fallback"
    )
  );
}

function splitMarkdownTable(
  unit: StructuralUnit,
  maxTokens: number
): StructuralUnit[] {
  if (unit.tokenCount <= maxTokens) {
    return [unit];
  }

  const lines = unit.content.split(/\r?\n/);
  const firstTableLine = lines.findIndex((line) => line.trim().startsWith("|"));
  if (firstTableLine < 0 || lines.length - firstTableLine < 3) {
    return [unit];
  }

  const prefix = lines.slice(0, firstTableLine).filter(Boolean);
  const header = lines.slice(firstTableLine, firstTableLine + 2);
  const rows = lines.slice(firstTableLine + 2).filter(Boolean);
  const chunks: StructuralUnit[] = [];
  let currentRows: string[] = [];

  const flush = () => {
    if (!currentRows.length) {
      return;
    }
    const content = [...prefix, ...header, ...currentRows].join("\n");
    chunks.push(
      makeUnit(content, unit.metadata, "table", "structure-table-rows")
    );
    currentRows = [];
  };

  for (const row of rows) {
    const candidate = [...prefix, ...header, ...currentRows, row].join("\n");
    if (currentRows.length > 0 && countTokens(candidate) > maxTokens) {
      flush();
    }
    currentRows.push(row);
  }
  flush();

  // 每一块都重复表头，检索到中间行时仍然知道每列代表什么。
  return chunks.length ? chunks : [unit];
}

async function groupTextUnitsSemantically(
  units: StructuralUnit[],
  config: StructuredChunkerConfig
): Promise<StructuralUnit[]> {
  const textUnitIndexes = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.sourceType === "text");
  if (textUnitIndexes.length < 2) {
    return units;
  }

  let embeddings: number[][];
  try {
    embeddings = await embedInBatches(
      textUnitIndexes.map(({ unit }) => unit.content),
      config.semanticEmbeddingBatchSize
    );
  } catch (error) {
    // 语义切分失败只关闭这一层，结构、Token 和字符保护仍继续生效。
    console.warn("Semantic chunk boundary detection failed:", error);
    return units;
  }

  const embeddingByUnitIndex = new Map<number, number[]>(
    textUnitIndexes.map(({ index }, embeddingIndex) => [
      index,
      embeddings[embeddingIndex] || []
    ])
  );
  const grouped: StructuralUnit[] = [];
  let current: StructuralUnit | null = null;
  let previousUnitIndex: number | null = null;

  units.forEach((unit, unitIndex) => {
    if (unit.sourceType !== "text") {
      if (current) {
        grouped.push(current);
        current = null;
      }
      grouped.push(unit);
      previousUnitIndex = null;
      return;
    }

    if (!current || previousUnitIndex === null) {
      current = unit;
      previousUnitIndex = unitIndex;
      return;
    }

    const similarity = cosineSimilarity(
      embeddingByUnitIndex.get(previousUnitIndex) || [],
      embeddingByUnitIndex.get(unitIndex) || []
    );
    const tokenCount = current.tokenCount + unit.tokenCount;
    const canMerge =
      tokenCount <= config.targetTokens &&
      hasSameStructuralContext(current, unit) &&
      similarity >= config.semanticSimilarityThreshold;

    if (canMerge) {
      current = mergeUnits(current, unit, similarity);
    } else {
      grouped.push(current);
      current = unit;
    }
    previousUnitIndex = unitIndex;
  });

  if (current) {
    grouped.push(current);
  }
  return grouped;
}

async function embedInBatches(
  texts: string[],
  batchSize: number
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let index = 0; index < texts.length; index += batchSize) {
    embeddings.push(
      ...(await embeddingProvider.embedTexts(texts.slice(index, index + batchSize)))
    );
  }
  return embeddings;
}

function mergeUnits(
  left: StructuralUnit,
  right: StructuralUnit,
  similarity: number
): StructuralUnit {
  const content = `${left.content}\n\n${right.content}`;
  return {
    content,
    sourceType: "text",
    tokenCount: countTokens(content),
    metadata: {
      ...mergeMetadata(left.metadata, right.metadata),
      splitStrategy: "semantic",
      semanticSimilarity: Number(similarity.toFixed(6)),
      // 合并多个版面块后不再伪造一个 bbox；原块编号仍可用于精确回溯。
      bbox: undefined
    }
  };
}

function mergeMetadata(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...left,
    ...right,
    originalBlockIndexes: [
      ...new Set([
        ...getNumberArray(left.originalBlockIndexes),
        ...getNumberArray(right.originalBlockIndexes)
      ])
    ],
    links: [
      ...new Set([
        ...getStringArray(left.links),
        ...getStringArray(right.links)
      ])
    ]
  };
}

function hasSameStructuralContext(
  left: StructuralUnit,
  right: StructuralUnit
): boolean {
  const leftPage = getPositiveNumber(left.metadata.pageNumber);
  const rightPage = getPositiveNumber(right.metadata.pageNumber);
  if (leftPage && rightPage && leftPage !== rightPage) {
    return false;
  }

  return (
    JSON.stringify(getStringArray(left.metadata.sectionPath)) ===
    JSON.stringify(getStringArray(right.metadata.sectionPath))
  );
}

function makeUnit(
  content: string,
  metadata: Record<string, unknown>,
  sourceType: ChunkSourceType,
  splitStrategy: string
): StructuralUnit {
  const normalizedContent = content.trim();
  return {
    content: normalizedContent,
    sourceType,
    tokenCount: countTokens(normalizedContent),
    metadata: {
      ...metadata,
      sourceType,
      splitStrategy
    }
  };
}

function prependHeading(heading: string, content: string): string {
  return content.includes(heading) ? content : `${heading}\n\n${content}`;
}

function splitNaturalParagraphs(content: string): string[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [content];
}

function getSourceType(
  metadata: Record<string, unknown>,
  fileType: string
): ChunkSourceType {
  const sourceType = metadata.sourceType;
  if (
    sourceType === "table" ||
    sourceType === "image_ocr" ||
    sourceType === "image_summary"
  ) {
    return sourceType;
  }
  return fileType === "image" ? "image_ocr" : "text";
}

function getOriginalBlockIndex(
  metadata: Record<string, unknown>,
  fallbackIndex: number
): number {
  const value = Number(metadata.documentIndex);
  return Number.isInteger(value) && value >= 0 ? value : fallbackIndex;
}

function getCharacterSeparators(fileType: string): string[] {
  if (fileType === "markdown") {
    return [
      "\n# ",
      "\n## ",
      "\n### ",
      "\n\n",
      "\n",
      "。",
      "！",
      "？",
      "；",
      "，",
      ". ",
      " ",
      ""
    ];
  }

  return [
    "\n\n",
    "\n",
    "。",
    "！",
    "？",
    "；",
    "，",
    ". ",
    " ",
    ""
  ];
}

function countTokens(text: string): number {
  return tokenEncoding.encode(text).length;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator ? dotProduct / denominator : 0;
}

function getNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((item) => Number.isInteger(item) && item >= 0)
    : [];
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function getPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
