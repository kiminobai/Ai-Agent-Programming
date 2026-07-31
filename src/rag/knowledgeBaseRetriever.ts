import { getUploadedDocument } from "./uploadedDocumentStore";
import { listKnowledgeBaseDocuments } from "./knowledgeBaseStore";
import {
  selectKnowledgeBaseRagArchitecture,
  type RagArchitecture,
  type RagSourceScope
} from "./ragArchitectureRouter";
import {
  searchGraphDocumentIndex,
  type GraphRagSearchMode
} from "./graphRag";
import {
  searchHybridDocumentIndex,
  searchVectorDocumentIndex,
  type VectorSearchChunk
} from "./vectorDocumentIndex";

export interface KnowledgeBaseRetrievedChunk extends VectorSearchChunk {
  // 知识库会把多份资料的 chunk 混在一起检索，所以每个 chunk 必须带来源信息。
  documentId: string;
  fileName: string;
  version: string;
}

export interface KnowledgeBaseRetrievalResult {
  knowledgeBaseId: string;
  // architecture 表示本次怎么检索；sourceScope 表示从知识库还是多文档范围检索。
  architecture: RagArchitecture;
  sourceScope: RagSourceScope;
  reason: string;
  graph?: {
    searchMode: GraphRagSearchMode;
    matchedEntities: string[];
    expandedEntities: string[];
    generatedQuestions: string[];
  };
  chunks: KnowledgeBaseRetrievedChunk[];
  documents: Array<{
    documentId: string;
    fileName: string;
    version: string;
    chunkCount: number;
    textLength: number;
  }>;
}

export async function searchKnowledgeBase(
  knowledgeBaseId: string,
  question: string
): Promise<KnowledgeBaseRetrievalResult> {
  // 学习点：知识库检索和上传文档检索不是一个 sourceScope。
  // 但当前项目会复用同一套 Hybrid RAG 检索链路。
  const decision = await selectKnowledgeBaseRagArchitecture(question);
  const documents = listKnowledgeBaseDocuments(knowledgeBaseId);

  if (documents.length === 0) {
    throw new Error(`Knowledge base "${knowledgeBaseId}" has no indexed documents.`);
  }

  const retrievedGroups = await Promise.all(
    documents.map(async (record) => {
      // 步骤 1：知识库文档在索引阶段会保存成 uploaded-like record。
      // 这样可以复用上传文档的 chunk / embedding / hybrid 检索函数。
      const uploadedLikeDocument = getUploadedDocument(record.documentId);

      if (!uploadedLikeDocument) {
        // 元数据存在但上传文档记录缺失时，跳过这份资料，避免整次知识库检索失败。
        return [];
      }

      // 步骤 2：对每份文档单独执行 Hybrid 或 GraphRAG 检索。
      // 为什么不是先把所有 chunk 混成一个巨大索引：
      // 当前学习版保持每份文档独立索引，方便版本隔离、删除和定位来源。
      const result =
        decision.architecture === "2-step-rag"
          ? await searchVectorDocumentIndex(uploadedLikeDocument, question)
          : decision.architecture === "graph-rag"
            ? await searchGraphDocumentIndex(uploadedLikeDocument, question)
            : await searchHybridDocumentIndex(uploadedLikeDocument, question);

      // 步骤 3：给 chunk 补上来源文档和版本号。
      // 模型回答时才能知道内容来自哪份资料。
      return result.chunks.map((chunk) => ({
        ...chunk,
        documentId: record.documentId,
        fileName: record.fileName,
        version: record.version
      }));
    })
  );

  const chunks = retrievedGroups
    .flat()
    .sort((left, right) => {
      // 步骤 4：多文档结果合并后统一按 rerankScore 排序。
      // 不是每份文档固定拿几个，而是让更相关的片段排在前面。
      if (right.rerankScore !== left.rerankScore) {
        return right.rerankScore - left.rerankScore;
      }

      return left.fileName.localeCompare(right.fileName);
    })
    .slice(0, 8);
  // GraphRAG 模式下额外汇总图谱命中的实体，供服务端构造提示词时使用。
  // 普通用户界面不展示这些内部调试信息。
  const graph =
    decision.architecture === "graph-rag"
      ? await collectKnowledgeBaseGraphSummary(documents, question)
      : undefined;

  return {
    knowledgeBaseId,
    architecture: decision.architecture,
    sourceScope: decision.sourceScope,
    reason: decision.reason,
    graph,
    chunks,
    documents: documents.map((document) => ({
      documentId: document.documentId,
      fileName: document.fileName,
      version: document.version,
      chunkCount: document.chunkCount,
      textLength: document.textLength
    }))
  };
}

async function collectKnowledgeBaseGraphSummary(
  documents: ReturnType<typeof listKnowledgeBaseDocuments>,
  question: string
): Promise<KnowledgeBaseRetrievalResult["graph"]> {
  // 多文档 GraphRAG 会对每份文档分别扩展图谱，然后把实体和生成问题去重合并。
  // 这不是再次给用户展示来源，而是帮助模型知道本次命中了哪些关系线索。
  const matchedEntities = new Set<string>();
  const expandedEntities = new Set<string>();
  const generatedQuestions = new Set<string>();
  let searchMode: GraphRagSearchMode = "basic-search";

  for (const record of documents) {
    const uploadedLikeDocument = getUploadedDocument(record.documentId);
    if (!uploadedLikeDocument) {
      continue;
    }

    const result = await searchGraphDocumentIndex(uploadedLikeDocument, question);
    searchMode = result.graph.searchMode;
    result.graph.matchedEntities.forEach((entity) => matchedEntities.add(entity));
    result.graph.expandedEntities.forEach((entity) => expandedEntities.add(entity));
    result.graph.generatedQuestions.forEach((item) => generatedQuestions.add(item));
  }

  return {
    searchMode,
    matchedEntities: [...matchedEntities],
    expandedEntities: [...expandedEntities],
    generatedQuestions: [...generatedQuestions].slice(0, 8)
  };
}
