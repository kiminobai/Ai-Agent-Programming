import { embeddingProvider } from "./embeddingProvider";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";

// 学习点：architecture 表示“这次 RAG 要怎么执行”。
// 这里按官方学习顺序区分三种：2-step、Agentic、Hybrid。
export type RagArchitecture = "2-step-rag" | "agentic-rag" | "hybrid-rag";

// 学习点：sourceScope 表示“资料从哪里来”。
// 它不是 RAG 架构，不要和 architecture 混在一起。
export type RagSourceScope =
  | "uploaded-document"
  | "knowledge-base"
  | "multi-document";

export interface RagArchitectureDecision {
  architecture: RagArchitecture;
  sourceScope: RagSourceScope;
  reason: string;
}

const SEMANTIC_AGENTIC_THRESHOLD = 0.72;
const SEMANTIC_HYBRID_THRESHOLD = 0.72;
const SEMANTIC_MARGIN = 0.03;

// 学习点：这些词表示用户想看整份文档，所以更适合 Hybrid RAG。
const WHOLE_DOCUMENT_PATTERNS = [
  "全文",
  "整份",
  "整个",
  "整体",
  "全篇",
  "总结",
  "概括",
  "概览",
  "分析这个",
  "分析文档",
  "讲一下",
  "目录",
  "大纲",
  "overview",
  "summarize",
  "summary",
  "whole document",
  "entire document"
];

// 学习点：这些词表示用户不只是问答案，而是要 AI 继续加工、生成或对比。
// 这种情况更像 Agentic RAG，因为 Agent 可能需要自己决定怎么调用工具。
const AGENTIC_PATTERNS = [
  "对比",
  "比较",
  "生成",
  "写一个",
  "帮我写",
  "改成",
  "提取并",
  "总结并",
  "分析并",
  "计划",
  "路线",
  "学习路线",
  "产出",
  "步骤",
  "流程",
  "表格",
  "多轮",
  "继续",
  "根据刚才",
  "compare",
  "generate",
  "create",
  "rewrite",
  "extract and",
  "summarize and",
  "plan",
  "workflow"
];

// 学习点：这些词表示用户想查“长期知识库”，不是只问当前上传的附件。
const KNOWLEDGE_BASE_PATTERNS = [
  "知识库",
  "学习手册",
  "资料库",
  "长期资料",
  "所有版本",
  "v8",
  "knowledge base",
  "manual"
];

// 学习点：这些词表示用户可能要跨多个文档或多个版本查资料。
const MULTI_DOCUMENT_PATTERNS = [
  "多个文档",
  "多份文档",
  "所有文档",
  "全部资料",
  "不同版本",
  "跨文档",
  "多版本",
  "multi document",
  "multiple documents",
  "all documents"
];

// 学习点：当关键词没有命中时，用这些例子做语义判断。
// 用户问题和这些例子越像，就越可能走 Agentic RAG。
const AGENTIC_EXAMPLES = [
  "根据这份文档生成一份学习计划",
  "对比文档里的几个方案并整理成表格",
  "继续刚才的分析并改写成面试题",
  "从文件中提取重点并生成行动步骤",
  "compare the options and create a plan"
];

// 学习点：这些例子代表“总结全文 / 整体分析”的语义。
// 用户问题和它们越像，就越可能走 Hybrid RAG。
const HYBRID_EXAMPLES = [
  "总结这份文档的整体内容",
  "分析整个 PDF 的结构和重点",
  "概括全文并说明主要章节",
  "提取这份资料的目录和大纲",
  "summarize the whole document"
];

let semanticExampleEmbeddingsPromise: Promise<{
  agentic: number[][];
  hybrid: number[][];
}> | null = null;

/**
 * 学习点：这是“上传文档问答”的 RAG 路由入口。
 *
 * 步骤 1：先看文件类型，图片需要模型能力判断，所以走 Agentic。
 * 步骤 2：看关键词，判断是 Agentic 还是 Hybrid。
 * 步骤 3：关键词不明显时，用 embedding 做语义兜底。
 * 步骤 4：还是不明确，就默认 2-step RAG，用户体验最简单。
 */
export async function selectDocumentRagArchitecture(
  question: string,
  document: UploadedDocumentRecord
): Promise<RagArchitectureDecision> {
  const normalizedQuestion = question.trim().toLowerCase();

  if (document.fileType === "image") {
    return {
      architecture: "agentic-rag",
      sourceScope: "uploaded-document",
      reason:
        "Images require the Agent to decide whether the selected model can analyze image content."
    };
  }

  if (includesAny(normalizedQuestion, AGENTIC_PATTERNS)) {
    return {
      architecture: "agentic-rag",
      sourceScope: "uploaded-document",
      reason:
        "The request asks for generation, comparison, rewriting, continuation, or another multi-step task."
    };
  }

  if (includesAny(normalizedQuestion, WHOLE_DOCUMENT_PATTERNS)) {
    return {
      architecture: "hybrid-rag",
      sourceScope: "uploaded-document",
      reason:
        "The request asks for whole-document or broad-scope analysis, so Hybrid RAG is used."
    };
  }

  const semanticDecision = await selectBySemanticSimilarity(question);
  if (semanticDecision) {
    return semanticDecision;
  }

  return {
    architecture: "2-step-rag",
    sourceScope: "uploaded-document",
    reason:
      "Default document QA path: retrieve once and generate directly for the simplest user experience."
  };
}

/**
 * 学习点：这是“知识库问答”的 RAG 路由。
 *
 * 知识库通常不是一份文件，而是很多资料或多个版本。
 * 所以当前项目先统一走 Hybrid RAG，提高召回范围。
 */
export function selectKnowledgeBaseRagArchitecture(
  question: string
): RagArchitectureDecision {
  const normalizedQuestion = question.trim().toLowerCase();
  const asksAcrossDocuments = includesAny(normalizedQuestion, MULTI_DOCUMENT_PATTERNS);

  return {
    architecture: "hybrid-rag",
    sourceScope: asksAcrossDocuments ? "multi-document" : "knowledge-base",
    reason: asksAcrossDocuments
      ? "The request searches across multiple knowledge-base documents or versions, using Hybrid RAG."
      : "The request targets the long-term knowledge base, using Hybrid RAG."
  };
}

export function shouldUseKnowledgeBase(question: string): boolean {
  const normalizedQuestion = question.trim().toLowerCase();
  return (
    includesAny(normalizedQuestion, KNOWLEDGE_BASE_PATTERNS) ||
    includesAny(normalizedQuestion, MULTI_DOCUMENT_PATTERNS)
  );
}

// 学习点：embedding 不只用于“搜文档”，也可以用于“判断问题更像哪类意图”。
async function selectBySemanticSimilarity(
  question: string
): Promise<RagArchitectureDecision | null> {
  try {
    const examples = await getSemanticExampleEmbeddings();
    const queryEmbedding = await embeddingProvider.embedText(question);
    const agenticScore = maxSimilarity(queryEmbedding, examples.agentic);
    const hybridScore = maxSimilarity(queryEmbedding, examples.hybrid);

    if (
      agenticScore >= SEMANTIC_AGENTIC_THRESHOLD &&
      agenticScore >= hybridScore + SEMANTIC_MARGIN
    ) {
      return {
        architecture: "agentic-rag",
        sourceScope: "uploaded-document",
        reason: `Semantic routing matched Agentic RAG intent with score ${agenticScore.toFixed(3)}.`
      };
    }

    if (hybridScore >= SEMANTIC_HYBRID_THRESHOLD) {
      return {
        architecture: "hybrid-rag",
        sourceScope: "uploaded-document",
        reason: `Semantic routing matched Hybrid RAG intent with score ${hybridScore.toFixed(3)}.`
      };
    }
  } catch (error) {
    console.warn("Semantic RAG routing failed, falling back to 2-step RAG:", error);
  }

  return null;
}

function getSemanticExampleEmbeddings(): Promise<{
  agentic: number[][];
  hybrid: number[][];
}> {
  if (!semanticExampleEmbeddingsPromise) {
    semanticExampleEmbeddingsPromise = embeddingProvider
      .embedTexts([...AGENTIC_EXAMPLES, ...HYBRID_EXAMPLES])
      .then((embeddings) => ({
        agentic: embeddings.slice(0, AGENTIC_EXAMPLES.length),
        hybrid: embeddings.slice(AGENTIC_EXAMPLES.length)
      }));
  }

  return semanticExampleEmbeddingsPromise;
}

function maxSimilarity(queryEmbedding: number[], examples: number[][]): number {
  return Math.max(
    0,
    ...examples.map((exampleEmbedding) =>
      cosineSimilarity(queryEmbedding, exampleEmbedding)
    )
  );
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dotProduct = 0;
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    dotProduct += left[index] * right[index];
  }

  return Number(dotProduct.toFixed(6));
}

function includesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}
