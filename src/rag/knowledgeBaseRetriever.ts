import { getUploadedDocument } from "./uploadedDocumentStore";
import { listKnowledgeBaseDocuments } from "./knowledgeBaseStore";
import {
  selectKnowledgeBaseRagArchitecture,
  type RagArchitecture,
  type RagSourceScope
} from "./ragArchitectureRouter";
import { searchHybridDocumentIndex, type VectorSearchChunk } from "./vectorDocumentIndex";

export interface KnowledgeBaseRetrievedChunk extends VectorSearchChunk {
  documentId: string;
  fileName: string;
  version: string;
}

export interface KnowledgeBaseRetrievalResult {
  knowledgeBaseId: string;
  architecture: RagArchitecture;
  sourceScope: RagSourceScope;
  reason: string;
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
  const decision = selectKnowledgeBaseRagArchitecture(question);
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
        return [];
      }

      // 步骤 2：对每份文档单独执行 Hybrid RAG 检索。
      const result = await searchHybridDocumentIndex(uploadedLikeDocument, question);

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

  return {
    knowledgeBaseId,
    architecture: decision.architecture,
    sourceScope: decision.sourceScope,
    reason: decision.reason,
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
