import { tool } from "langchain";
import { z } from "zod";
import { AgentContext } from "../../agents/agentContext";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";
import {
  RAG_RETRIEVAL_CONFIG
} from "../../rag/documentChunkLab";
import { searchGraphDocumentIndex } from "../../rag/graphRag";
import { selectDocumentRagArchitecture } from "../../rag/ragArchitectureRouter";
import {
  searchHybridDocumentIndex,
  searchVectorDocumentIndex
} from "../../rag/vectorDocumentIndex";
import { getUploadedDocument } from "../../rag/uploadedDocumentStore";

export async function retrieveUploadedDocumentResult(
  task: string,
  threadId: string
) {
  const document = getUploadedDocument(threadId);

  if (!document) {
    return {
      ok: false,
      reason: "No uploaded document is attached to the current thread."
    };
  }

  if (!document.text.trim()) {
    return {
      ok: false,
      reason:
        "The uploaded file was saved, but this file type has no extracted text for RAG yet.",
      fileName: document.fileName,
      fileType: document.fileType,
      parseStatus: document.parseStatus,
      supportedForRag: [
        "markdown",
        "pdf",
        "text",
        "pptx",
        "docx",
        "xlsx",
        "xls",
        "csv",
        "html",
        "image text recognition"
      ]
    };
  }

  const decision = await selectDocumentRagArchitecture(task, document);
  const result =
    decision.architecture === "2-step-rag"
      ? await searchVectorDocumentIndex(document, task)
      : decision.architecture === "graph-rag"
        ? await searchGraphDocumentIndex(document, task)
        : await searchHybridDocumentIndex(document, task);
  const selectedChunks = result.chunks
    .sort((left, right) => left.index - right.index)
    .map(({ embedding, ...chunk }) => ({
      ...chunk,
      content:
        chunk.content.length > RAG_RETRIEVAL_CONFIG.maxChunkCharacters
          ? `${chunk.content.slice(0, RAG_RETRIEVAL_CONFIG.maxChunkCharacters)}...(truncated)`
          : chunk.content
    }));
  const retrievalValidation =
    "validation" in result &&
    result.validation &&
    typeof result.validation === "object"
      ? (result.validation as {
          retrievalStrategy: string;
          isLikelySufficient: boolean;
          note: string;
        })
      : null;

  return {
    ok: true,
    purpose:
      "The uploaded document was searched with the RAG architecture selected for the user's current task.",
    answeringRule:
      "Answer from the returned chunks first. Do not print raw chunk ids, scores, or internal retrieval metadata to the user.",
    task,
    architecture: decision.architecture,
    architectureReason: decision.reason,
    sourceScope: decision.sourceScope,
    retrievalQuery: task,
    fileName: document.fileName,
    fileType: document.fileType,
    totalCharacters: document.text.length,
    totalChunkCount: result.index.chunkCount,
    returnedChunkCount: selectedChunks.length,
    enhancedQuery: "enhancedQuery" in result ? result.enhancedQuery : task,
    retrievalStrategy:
      retrievalValidation?.retrievalStrategy ?? "vector-only",
    retrievalValidation:
      retrievalValidation ?? {
        isLikelySufficient: selectedChunks.length > 0,
        note:
          "2-Step RAG uses direct vector retrieval and skips the enhanced validation stage."
      },
    vectorIndex: {
      dimensions: result.index.dimensions,
      builtAt: result.index.builtAt,
      chunkCount: result.index.chunkCount
    },
    retrievalConfig: RAG_RETRIEVAL_CONFIG,
    chunks: selectedChunks
  };
}

export const uploadedDocumentTool = tool(
  async ({ task }, runtime: ToolMemoryRuntime) => {
    const context = (runtime.context ?? {}) as AgentContext;
    // 学习点：工具只读取当前 thread 绑定的文件。
    // 这样不会把其它对话上传的文档混进当前回答。
    const document = getUploadedDocument(context.threadId);
    const result = await retrieveUploadedDocumentResult(task, context.threadId);

    return writeToolContext(
      runtime,
      "retrieve_uploaded_document_chunks",
      { task, threadId: context.threadId, fileName: document?.fileName },
      result
    );
  },
  {
    name: "retrieve_uploaded_document_chunks",
    description:
      "Retrieve context from the file attached to the current conversation. Use only when the user's question needs that file. The tool automatically chooses 2-Step RAG, Hybrid RAG, or GraphRAG according to the task.",
    schema: z.object({
      task: z
        .string()
        .min(1)
        .describe(
          "The user's document-related task, such as analyze this file, summarize it, extract key points, compare sections, split it, or answer questions from it."
        )
    })
  }
);
