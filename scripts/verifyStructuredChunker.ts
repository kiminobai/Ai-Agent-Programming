import assert from "node:assert/strict";

// 校验脚本固定使用本地 hash embedding，避免测试切分时调用付费 API。
process.env.EMBEDDING_PROVIDER = "hash";

async function main(): Promise<void> {
  const { Document } = await import("@langchain/core/documents");
  const { splitDocumentsWithStructure } = await import(
    "../src/rag/structuredDocumentChunker"
  );

  const tableRows = Array.from(
    { length: 140 },
    (_, index) => `| ${index} | 项目${index} | 说明${index} |`
  ).join("\n");
  const documents = [
    new Document({
    pageContent: "第一章",
    metadata: {
      blockType: "heading",
      documentIndex: 0,
      sectionPath: ["第一章"],
      pageNumber: 1
    }
  }),
  new Document({
    pageContent: "Python 虚拟环境用于隔离项目依赖。",
    metadata: {
      blockType: "paragraph",
      documentIndex: 1,
      sectionPath: ["第一章"],
      pageNumber: 1
    }
  }),
  new Document({
    pageContent: "虚拟环境可以避免不同项目的依赖版本互相冲突。",
    metadata: {
      blockType: "paragraph",
      documentIndex: 2,
      sectionPath: ["第一章"],
      pageNumber: 1
    }
  }),
  new Document({
    pageContent: [
      "| 编号 | 项目 | 说明 |",
      "| --- | --- | --- |",
      tableRows
    ].join("\n"),
    metadata: {
      blockType: "table",
      sourceType: "table",
      documentIndex: 3,
      pageNumber: 2
    }
  }),
  new Document({
    pageContent: "图片展示系统架构。",
    metadata: {
      blockType: "image",
      sourceType: "image_summary",
      documentIndex: 4,
      pageNumber: 3
    }
    })
  ];

  const chunks = await splitDocumentsWithStructure(documents, "pdf", {
    targetTokens: 120,
    maxTokens: 160,
    overlapTokens: 20,
    semanticSimilarityThreshold: 0.1,
    semanticEmbeddingBatchSize: 8
  });
  const tableChunks = chunks.filter(
    (chunk) => chunk.metadata.sourceType === "table"
  );
  const imageChunks = chunks.filter(
    (chunk) => chunk.metadata.sourceType === "image_summary"
  );

  assert.ok(chunks[0]?.pageContent.includes("第一章"), "标题没有并入后续正文");
  assert.ok(tableChunks.length > 1, "长表格没有按行拆分");
  assert.ok(
    tableChunks.every((chunk) =>
      chunk.pageContent.includes("| 编号 | 项目 | 说明 |")
    ),
    "表格分块没有重复表头"
  );
  assert.equal(imageChunks.length, 1, "图片说明不应与普通正文混合");
  assert.ok(
    chunks.every((chunk) => Number(chunk.metadata.tokenCount) <= 160),
    "存在超过 Token 上限的 chunk"
  );

  console.log(
    JSON.stringify(
      {
        status: "passed",
        chunkCount: chunks.length,
        tableChunkCount: tableChunks.length,
        strategies: [
          ...new Set(chunks.map((chunk) => chunk.metadata.splitStrategy))
        ]
      },
      null,
      2
    )
  );
}

void main();
