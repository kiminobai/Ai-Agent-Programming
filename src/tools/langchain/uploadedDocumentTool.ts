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
import { searchHybridDocumentIndex } from "../../rag/vectorDocumentIndex";
import { getUploadedDocument } from "../../rag/uploadedDocumentStore";

export const uploadedDocumentTool = tool(
  async ({ task }, runtime: ToolMemoryRuntime) => {
    const context = (runtime.context ?? {}) as AgentContext;
    // 学习点：工具只读取当前 thread 绑定的文件。
    // 这样不会把其它对话上传的文档混进当前回答。
    const document = getUploadedDocument(context.threadId);

    if (!document) {
      return writeToolContext(
        runtime,
        "retrieve_uploaded_document_chunks",
        { task, threadId: context.threadId },
        {
          ok: false,
          reason: "No uploaded document is attached to the current thread."
        }
      );
    }

    if (!document.text.trim()) {
      // 学习点：文件保存成功但没有可检索文本时，告诉 Agent 当前限制。
      // 不把 OCR、解析器等内部细节直接丢给用户。
      return writeToolContext(
        runtime,
        "retrieve_uploaded_document_chunks",
        { task, threadId: context.threadId, fileName: document.fileName },
        {
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
        }
      );
    }

    // 学习点：Agentic RAG 里的“文档工具”内部复用 Hybrid RAG。
    // 也就是：检索 -> 融合 -> rerank -> 验证 -> 返回精选上下文。
    const result = await searchHybridDocumentIndex(document, task);
    const selectedChunks = result.chunks
      .sort((left, right) => left.index - right.index)
      .map(({ embedding, ...chunk }) => ({
        ...chunk,
        content:
          chunk.content.length > RAG_RETRIEVAL_CONFIG.maxChunkCharacters
            ? `${chunk.content.slice(0, RAG_RETRIEVAL_CONFIG.maxChunkCharacters)}...(truncated)`
            : chunk.content
      }));

    return writeToolContext(
      runtime,
      "retrieve_uploaded_document_chunks",
      { task, threadId: context.threadId, fileName: document.fileName },
      {
        ok: true,
        // 学习点：answeringRule 是给模型看的输出约束。
        // 目的是避免把 chunk id、score 等开发者信息展示给用户。
        purpose:
          "The uploaded document was searched with Hybrid RAG: query enhancement, vector similarity, SQLite FTS5/BM25 keyword retrieval, algorithmic rerank, retrieval validation, and whole-document representative retrieval when needed.",
        answeringRule:
          "Answer from the returned chunks first. Do not print raw chunk ids, scores, or internal retrieval metadata to the user.",
        task,
        retrievalQuery: task,
        fileName: document.fileName,
        fileType: document.fileType,
        totalCharacters: document.text.length,
        totalChunkCount: result.index.chunkCount,
        returnedChunkCount: selectedChunks.length,
        enhancedQuery: result.enhancedQuery,
        retrievalStrategy: result.validation.retrievalStrategy,
        retrievalValidation: result.validation,
        vectorIndex: {
          dimensions: result.index.dimensions,
          builtAt: result.index.builtAt,
          chunkCount: result.index.chunkCount
        },
        retrievalConfig: RAG_RETRIEVAL_CONFIG,
        chunks: selectedChunks
      }
    );
  },
  {
    name: "retrieve_uploaded_document_chunks",
    description:
      "Retrieve document context from uploaded Markdown, TXT, PDF, PPTX, DOCX, XLSX/XLS/CSV, HTML, or images with recognized text using Hybrid RAG. The tool enhances queries, combines vector similarity with keyword matching, validates retrieval quality, and returns representative context for whole-document analysis.",
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
