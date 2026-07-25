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
import { searchVectorDocumentIndex } from "../../rag/vectorDocumentIndex";
import { getUploadedDocument } from "../../rag/uploadedDocumentStore";

export const uploadedDocumentTool = tool(
  async ({ task }, runtime: ToolMemoryRuntime) => {
    const context = (runtime.context ?? {}) as AgentContext;
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
          supportedForRag: ["markdown", "pdf", "text"]
        }
      );
    }

    const result = await searchVectorDocumentIndex(document, task);
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
        purpose:
          "The uploaded document was searched with a local vector index. Only the most relevant chunks were returned to avoid overflowing the model context.",
        answeringRule:
          "Answer from the returned chunks first. Do not ask for or print every chunk unless the user narrows the request.",
        task,
        retrievalQuery: task,
        fileName: document.fileName,
        fileType: document.fileType,
        totalCharacters: document.text.length,
        totalChunkCount: result.index.chunkCount,
        returnedChunkCount: selectedChunks.length,
        retrievalStrategy: "local-vector-cosine",
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
      "Retrieve only the most relevant chunks from the uploaded Markdown, TXT, or PDF document with a simple vector index. Use this RAG tool when the user asks to analyze, summarize, extract, compare, or answer questions based on the uploaded file. Do not load the whole document into context.",
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
