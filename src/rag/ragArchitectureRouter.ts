import { embeddingProvider } from "./embeddingProvider";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";

// 学习点：architecture 表示“这次 RAG 怎么执行”，sourceScope 表示“资料从哪里来”。
// 二者不要混在一起：同一个知识库问题，也可能走 Hybrid RAG 或 GraphRAG。
export type RagArchitecture =
  | "2-step-rag"
  | "agentic-rag"
  | "hybrid-rag"
  | "graph-rag";

export type RagSourceScope =
  | "uploaded-document"
  | "knowledge-base"
  | "multi-document";

export interface RagArchitectureDecision {
  architecture: RagArchitecture;
  sourceScope: RagSourceScope;
  reason: string;
}

type IntentScores = {
  agentic: number;
  hybrid: number;
  graph: number;
};

// 学习点：语义路由只是兜底，不是每次都跑。
// 先走关键词规则可以减少 embedding 请求；只有用户表达不明显时，才用这些阈值判断更像哪类 RAG。
const SEMANTIC_AGENTIC_THRESHOLD = 0.72;
const SEMANTIC_HYBRID_THRESHOLD = 0.72;
const SEMANTIC_GRAPH_THRESHOLD = 0.72;
const SEMANTIC_MARGIN = 0.03;

// 学习点：这些词代表“只问某个具体点”，应该优先走最省 token 的 2-step RAG。
const SIMPLE_QA_PATTERNS = [
  "是什么",
  "什么意思",
  "在哪里",
  "哪一页",
  "列出",
  "查找",
  "说明一下",
  "解释一下",
  "define",
  "what is",
  "where is",
  "find"
];

// 学习点：这些词代表“看整份资料”，需要更强召回和验证，适合 Hybrid RAG。
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

// 学习点：这些词代表“要产出、改写、计划、对比、多步处理”，适合 Agentic RAG。
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

// 学习点：这些词代表“关系、依赖、链路、因果”，适合 GraphRAG。
const GRAPH_RAG_PATTERNS = [
  "关系",
  "关联",
  "联系",
  "依赖",
  "影响",
  "链路",
  "因果",
  "为什么",
  "导致",
  "之间",
  "概念图",
  "知识图谱",
  "local search",
  "global search",
  "drift search",
  "basic search",
  "question generation",
  "graph",
  "relationship",
  "relation",
  "dependency",
  "impact",
  "cause"
];

const KNOWLEDGE_BASE_PATTERNS = [
  "知识库",
  "学习手册",
  "资料库",
  "长期资料",
  "所有版本",
  "v8",
  "v9",
  "knowledge base",
  "manual"
];

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

const AGENTIC_EXAMPLES = [
  "根据这份文档生成一份学习计划",
  "对比文档里的几个方案并整理成表格",
  "继续刚才的分析并改写成面试题",
  "从文件中提取重点并生成行动步骤",
  "compare the options and create a plan"
];

const HYBRID_EXAMPLES = [
  "总结这份文档的整体内容",
  "分析整个 PDF 的结构和重点",
  "概括全文并说明主要章节",
  "提取这份资料的目录和大纲",
  "summarize the whole document"
];

const GRAPH_EXAMPLES = [
  "解释文档中 LangChain、LangGraph 和 Memory 之间的关系",
  "这个方案里的工具调用和 Agent 状态有什么依赖关系",
  "分析这些概念之间的影响链路",
  "why does one component depend on another in this document",
  "show relationships between the key concepts"
];

let semanticExampleEmbeddingsPromise: Promise<{
  agentic: number[][];
  hybrid: number[][];
  graph: number[][];
}> | null = null;

/**
 * 给“当前对话上传的单个文件”选择 RAG 架构。
 *
 * 为什么 document 要传进来：
 * - 图片不是纯文本检索，必须先判断当前模型是否支持视觉能力。
 * - 文本文件才进入普通的 2-step / Hybrid / GraphRAG 路由。
 */
export async function selectDocumentRagArchitecture(
  question: string,
  document: UploadedDocumentRecord
): Promise<RagArchitectureDecision> {
  const normalizedQuestion = question.trim().toLowerCase();

  // 图片不是普通文本 RAG，必须让 Agent/模型能力判断是否能处理。
  if (document.fileType === "image") {
    return decision(
      "agentic-rag",
      "uploaded-document",
      "图片需要先判断当前模型是否支持视觉理解，所以交给 Agentic 路径。"
    );
  }

  return selectBestArchitecture(normalizedQuestion, "uploaded-document");
}

/**
 * 给“长期知识库 / 多文档资料”选择 RAG 架构。
 *
 * 注意：knowledge-base 不是一种 RAG architecture，它只是 sourceScope。
 * 具体用 Hybrid 还是 GraphRAG，仍然要看用户当前问题的意图。
 */
export async function selectKnowledgeBaseRagArchitecture(
  question: string
): Promise<RagArchitectureDecision> {
  const normalizedQuestion = question.trim().toLowerCase();
  const sourceScope = includesAny(normalizedQuestion, MULTI_DOCUMENT_PATTERNS)
    ? "multi-document"
    : "knowledge-base";

  return selectBestArchitecture(normalizedQuestion, sourceScope);
}

export function shouldUseKnowledgeBase(question: string): boolean {
  const normalizedQuestion = question.trim().toLowerCase();
  return (
    includesAny(normalizedQuestion, KNOWLEDGE_BASE_PATTERNS) ||
    includesAny(normalizedQuestion, MULTI_DOCUMENT_PATTERNS)
  );
}

/**
 * RAG 自动路由的核心入口。
 *
 * 设计原则：
 * 1. 能用关键词明确判断，就不要再做 embedding 语义判断，节省计算。
 * 2. 只有关键词判断不出来时，才用 embedding 兜底。
 * 3. 仍然不明确时，默认走最低成本的 2-step RAG。
 */
async function selectBestArchitecture(
  normalizedQuestion: string,
  sourceScope: RagSourceScope
): Promise<RagArchitectureDecision> {
  const keywordScores = scoreKeywordIntent(normalizedQuestion);
  const keywordDecision = selectByKeywordScores(keywordScores, sourceScope);

  // 学习点：关键词已经很明确时，不再额外做 embedding 意图判断，节省一次计算。
  if (keywordDecision) {
    return keywordDecision;
  }

  const semanticDecision = await selectBySemanticSimilarity(normalizedQuestion, sourceScope);
  if (semanticDecision) {
    return semanticDecision;
  }

  // 学习点：默认使用最低成本的 2-step RAG，只有有必要时才升级。
  return decision(
    "2-step-rag",
    sourceScope,
    "未检测到全局分析、多步任务或关系链路意图，默认使用最低成本的 2-step RAG。"
  );
}

function scoreKeywordIntent(value: string): IntentScores & { simple: number } {
  // 每类意图只做轻量字符串匹配。这里不是最终答案判断，只是决定走哪条 RAG 链路。
  return {
    simple: countMatches(value, SIMPLE_QA_PATTERNS),
    agentic: countMatches(value, AGENTIC_PATTERNS),
    hybrid: countMatches(value, WHOLE_DOCUMENT_PATTERNS),
    graph: countMatches(value, GRAPH_RAG_PATTERNS)
  };
}

function selectByKeywordScores(
  scores: IntentScores & { simple: number },
  sourceScope: RagSourceScope
): RagArchitectureDecision | null {
  // 学习点：如果用户明确要求“生成/改写/对比/继续处理”，优先 Agentic。
  if (scores.agentic > 0 && scores.agentic >= scores.hybrid && scores.agentic >= scores.graph) {
    return decision(
      "agentic-rag",
      sourceScope,
      "检测到生成、对比、改写或多步骤处理意图，使用 Agentic RAG。"
    );
  }

  // 学习点：关系链路问题优先 GraphRAG，因为它能利用实体关系扩展召回。
  if (scores.graph > 0 && scores.graph >= scores.hybrid) {
    return decision(
      "graph-rag",
      sourceScope,
      "检测到关系、依赖、影响、因果或链路意图，使用 GraphRAG。"
    );
  }

  // 学习点：全文总结、整体分析需要更广召回，使用 Hybrid。
  if (scores.hybrid > 0) {
    return decision(
      "hybrid-rag",
      sourceScope,
      "检测到全文总结、整体分析或大纲类意图，使用 Hybrid RAG。"
    );
  }

  // 学习点：明确简单问答时，直接 2-step，避免为了“高级”而浪费 token。
  if (scores.simple > 0) {
    return decision(
      "2-step-rag",
      sourceScope,
      "检测到简单问答意图，使用最低成本的 2-step RAG。"
    );
  }

  return null;
}

async function selectBySemanticSimilarity(
  question: string,
  sourceScope: RagSourceScope
): Promise<RagArchitectureDecision | null> {
  try {
    // 这里把用户问题和几组“典型意图样例”做向量相似度比较。
    // 它不是让 LLM 判断，而是用 embedding 做低成本语义分类。
    const examples = await getSemanticExampleEmbeddings();
    const queryEmbedding = await embeddingProvider.embedText(question);
    const agenticScore = maxSimilarity(queryEmbedding, examples.agentic);
    const hybridScore = maxSimilarity(queryEmbedding, examples.hybrid);
    const graphScore = maxSimilarity(queryEmbedding, examples.graph);

    if (
      agenticScore >= SEMANTIC_AGENTIC_THRESHOLD &&
      agenticScore >= hybridScore + SEMANTIC_MARGIN &&
      agenticScore >= graphScore + SEMANTIC_MARGIN
    ) {
      return decision(
        "agentic-rag",
        sourceScope,
        `语义路由匹配 Agentic RAG，score=${agenticScore.toFixed(3)}。`
      );
    }

    if (
      graphScore >= SEMANTIC_GRAPH_THRESHOLD &&
      graphScore >= hybridScore + SEMANTIC_MARGIN
    ) {
      return decision(
        "graph-rag",
        sourceScope,
        `语义路由匹配 GraphRAG，score=${graphScore.toFixed(3)}。`
      );
    }

    if (hybridScore >= SEMANTIC_HYBRID_THRESHOLD) {
      return decision(
        "hybrid-rag",
        sourceScope,
        `语义路由匹配 Hybrid RAG，score=${hybridScore.toFixed(3)}。`
      );
    }
  } catch (error) {
    console.warn("Semantic RAG routing failed, falling back to 2-step RAG:", error);
  }

  return null;
}

function getSemanticExampleEmbeddings(): Promise<{
  agentic: number[][];
  hybrid: number[][];
  graph: number[][];
}> {
  if (!semanticExampleEmbeddingsPromise) {
    // 意图样例 embedding 在当前进程内缓存一次，避免每次路由都重复计算。
    // 重启进程后会重新生成；这只是性能缓存，不是长期记忆。
    semanticExampleEmbeddingsPromise = embeddingProvider
      .embedTexts([...AGENTIC_EXAMPLES, ...HYBRID_EXAMPLES, ...GRAPH_EXAMPLES])
      .then((embeddings) => ({
        agentic: embeddings.slice(0, AGENTIC_EXAMPLES.length),
        hybrid: embeddings.slice(
          AGENTIC_EXAMPLES.length,
          AGENTIC_EXAMPLES.length + HYBRID_EXAMPLES.length
        ),
        graph: embeddings.slice(AGENTIC_EXAMPLES.length + HYBRID_EXAMPLES.length)
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

function countMatches(value: string, patterns: string[]): number {
  return patterns.reduce(
    (count, pattern) => count + (value.includes(pattern) ? 1 : 0),
    0
  );
}

function includesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

function decision(
  architecture: RagArchitecture,
  sourceScope: RagSourceScope,
  reason: string
): RagArchitectureDecision {
  return {
    architecture,
    sourceScope,
    reason
  };
}
