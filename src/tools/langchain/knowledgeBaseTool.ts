/**
 * 长期知识库检索工具。
 *
 * 与 uploadedDocumentTool 的区别：
 * - uploadedDocumentTool 只搜索当前 thread 上传的文件；
 * - knowledgeBaseTool 搜索 data/knowledge-bases 中已经索引的多版本资料。
 */
import { tool } from "langchain";
import { z } from "zod";
import { searchKnowledgeBase } from "../../rag/knowledgeBaseRetriever";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";
import { RAG_RETRIEVAL_CONFIG } from "../../rag/documentChunkLab";

const DEFAULT_KNOWLEDGE_BASE_ID = "ai-agent-learning-manual";

export async function retrieveKnowledgeBaseResult(
  task: string,
  knowledgeBaseId?: string
) {
  const selectedKnowledgeBase =
    knowledgeBaseId?.trim() || DEFAULT_KNOWLEDGE_BASE_ID;
  const result = await searchKnowledgeBase(selectedKnowledgeBase, task);
  const chunks = result.chunks.map(({ embedding, ...chunk }) => ({
    ...chunk,
    content:
      chunk.content.length > RAG_RETRIEVAL_CONFIG.maxChunkCharacters
        ? `${chunk.content.slice(0, RAG_RETRIEVAL_CONFIG.maxChunkCharacters)}...(truncated)`
        : chunk.content
  }));

  return {
    ok: true,
    purpose:
      "Search the indexed long-term knowledge base with automatically selected Hybrid or GraphRAG retrieval.",
    answeringRule:
      "Answer from the retrieved context. Mention document names or versions naturally when useful, but do not expose scores or internal chunk ids.",
    task,
    knowledgeBaseId: result.knowledgeBaseId,
    architecture: result.architecture,
    sourceScope: result.sourceScope,
    architectureReason: result.reason,
    searchedDocumentCount: result.documents.length,
    returnedChunkCount: chunks.length,
    graph: result.graph,
    chunks
  };
}

export const knowledgeBaseTool = tool(
  async ({ task, knowledgeBaseId }, runtime: ToolMemoryRuntime) => {
    const selectedKnowledgeBase =
      knowledgeBaseId?.trim() || DEFAULT_KNOWLEDGE_BASE_ID;
    const result = await retrieveKnowledgeBaseResult(
      task,
      selectedKnowledgeBase
    );

    return writeToolContext(
      runtime,
      "retrieve_knowledge_base",
      { task, knowledgeBaseId: selectedKnowledgeBase },
      result
    );
  },
  {
    name: "retrieve_knowledge_base",
    description:
      "Search the indexed AI Agent learning-manual knowledge base and its multiple document versions. Use when the user asks about the knowledge base, learning manual, stored materials, all documents, different versions, or cross-document comparisons.",
    schema: z.object({
      task: z
        .string()
        .min(1)
        .describe("The user's exact knowledge-base question or comparison task."),
      knowledgeBaseId: z
        .string()
        .optional()
        .describe(
          "Knowledge-base id. Omit to use ai-agent-learning-manual."
        )
    })
  }
);
