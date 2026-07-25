import { tool } from "langchain";
import { z } from "zod";
import { AgentContext } from "../../agents/agentContext";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";
import {
  retrieveUploadedDocumentChunks,
  RAG_RETRIEVAL_CONFIG
} from "../../rag/documentChunkLab";
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

    const result = await retrieveUploadedDocumentChunks(document, task);

    return writeToolContext(
      runtime,
      "retrieve_uploaded_document_chunks",
      { task, threadId: context.threadId, fileName: document.fileName },
      {
        ok: true,
        purpose:
          "The uploaded document was searched with a lightweight RAG retriever. Only the most relevant chunks were returned to avoid overflowing the model context.",
        answeringRule:
          "Answer from the returned chunks first. Do not ask for or print every chunk unless the user narrows the request.",
        task,
        retrievalQuery: result.query,
        fileName: result.fileName,
        fileType: result.fileType,
        totalCharacters: result.totalCharacters,
        totalChunkCount: result.totalChunkCount,
        returnedChunkCount: result.returnedChunkCount,
        retrievalStrategy: result.retrievalStrategy,
        retrievalConfig: RAG_RETRIEVAL_CONFIG,
        chunks: result.chunks
      }
    );
  },
  {
    name: "retrieve_uploaded_document_chunks",
    description:
      "Retrieve only the most relevant chunks from the uploaded Markdown, TXT, or PDF document. Use this RAG tool when the user asks to analyze, summarize, extract, compare, or answer questions based on the uploaded file. Do not load the whole document into context.",
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
