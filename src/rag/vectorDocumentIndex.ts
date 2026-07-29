import {
  RAG_RETRIEVAL_CONFIG,
  splitUploadedDocument
} from "./documentChunkLab";
import { sqliteDb } from "../db/sqlite";
import { embeddingProvider } from "./embeddingProvider";
import { vectorStore } from "./vectorStoreProvider";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";
import type { VectorDocumentIndex, VectorIndexedChunk } from "./vectorStore";

const MIN_TOKEN_LENGTH = 2;

// 学习点：这是检索返回给后续 Prompt 的 chunk。
// 除了原始文本，还会带上相似度、关键词分数、重排分数等内部信息。
export interface VectorSearchChunk extends VectorIndexedChunk {
  similarity: number;
  keywordScore: number;
  bm25Score: number;
  hybridScore: number;
  rerankScore: number;
  matchedTerms: string[];
}

// 学习点：Hybrid RAG 比 2-step 多一些中间结果。
// 这些字段主要给后端判断“检索质量够不够”，不应该直接展示给普通用户。
export interface HybridDocumentRetrievalResult {
  index: VectorDocumentIndex;
  queryEmbedding: number[];
  queryTerms: string[];
  enhancedQuery: string;
  chunks: VectorSearchChunk[];
  validation: {
    isWholeDocumentRequest: boolean;
    isLikelySufficient: boolean;
    bestHybridScore: number;
    bestRerankScore: number;
    matchedTermCount: number;
    retrievalStrategy: "hybrid-rag" | "hybrid-rag-whole-document" | "graph-rag";
    note: string;
  };
}

// 学习点：数据库负责长期保存，Map 只是当前 Node 进程里的临时缓存。
// 重启后 Map 会清空，但 SQLite/Chroma 里的索引还在。
const indexByThread = new Map<string, VectorDocumentIndex>();

/**
 * 学习点：这是 RAG 的“建索引”阶段。
 *
 * 步骤 1：把文档切成很多 chunk。
 * 步骤 2：把每个 chunk 变成 embedding 向量。
 * 步骤 3：把索引写入 Chroma/SQLite，保证重启后还能用。
 * 步骤 4：当前进程里也缓存一份，避免同一文档反复读取数据库。
 */
export async function buildVectorDocumentIndex(
  document: UploadedDocumentRecord
): Promise<VectorDocumentIndex> {
  // 建索引发生在文件被成功解析以后。
  // 如果文件解析失败，不应该进入这里，否则会把无效内容写入向量库和关键词索引。
  const chunks = await splitUploadedDocument(document);
  // 每个 chunk 都要转成 embedding，后续用户提问时才能做语义相似度检索。
  const embeddings = await embeddingProvider.embedTexts(
    chunks.map((chunk) => chunk.content)
  );
  const builtAt = new Date().toISOString();
  const index: VectorDocumentIndex = {
    threadId: document.threadId,
    userId: document.userId,
    fileName: document.fileName,
    builtAt,
    dimensions: embeddings[0]?.length || 0,
    chunkCount: chunks.length,
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] || []
    }))
  };

  indexByThread.set(document.threadId, index);
  // vectorStore 可能是 Chroma，也可能是 SQLite fallback，由 vectorStoreProvider 统一选择。
  await vectorStore.saveIndex(index);
  markVectorIndexPersisted(document.threadId);
  return index;
}

export function clearVectorDocumentIndex(threadId: string): void {
  // 删除对话或文件时，要同时清理内存缓存、向量索引和 GraphRAG 图谱。
  // 否则旧 chunk 可能继续参与检索，污染当前对话环境。
  indexByThread.delete(threadId);
  vectorStore.clearIndex(threadId);
  sqliteDb.prepare("DELETE FROM document_graph_edges WHERE thread_id = ?").run(threadId);
  sqliteDb.prepare("DELETE FROM document_graph_nodes WHERE thread_id = ?").run(threadId);
}

export async function getOrBuildVectorDocumentIndex(
  document: UploadedDocumentRecord
): Promise<VectorDocumentIndex> {
  const existingIndex = indexByThread.get(document.threadId);

  // 步骤 1：先查内存缓存。
  // 如果用户连续追问同一个文档，就不用每次重新读数据库。
  if (
    existingIndex &&
    existingIndex.fileName === document.fileName &&
    existingIndex.userId === document.userId
  ) {
    return existingIndex;
  }

  const persistedIndex = vectorStore.loadIndex(document.threadId);
  if (persistedIndex) {
    // 步骤 2：如果内存没有，就从持久化索引恢复。
    // 这就是为什么项目重启后仍然能继续使用已经建好的索引。
    const hydratedIndex = {
      ...persistedIndex,
      userId: document.userId,
      fileName: document.fileName
    };
    indexByThread.set(document.threadId, hydratedIndex);
    return hydratedIndex;
  }

  // 步骤 3：如果数据库也没有，才重新切分和向量化。
  return buildVectorDocumentIndex(document);
}

/**
 * 学习点：这是 2-step RAG。
 *
 * 步骤 1：把用户问题变成 query embedding。
 * 步骤 2：用 query embedding 去向量库找最相似的 chunk。
 * 步骤 3：把 TopK chunk 塞进 Prompt，让模型回答。
 *
 * 它不做 BM25、Rerank、Answer Validation，所以速度更快、逻辑更好理解。
 */
export async function searchVectorDocumentIndex(
  document: UploadedDocumentRecord,
  query: string
): Promise<{
  index: VectorDocumentIndex;
  queryEmbedding: number[];
  chunks: VectorSearchChunk[];
}> {
  const index = await getOrBuildVectorDocumentIndex(document);
  // 2-step RAG 只把问题转成向量，然后做一次 TopK 语义检索。
  // 它不跑关键词检索和重排，所以适合简单问答。
  const queryEmbedding = await embeddingProvider.embedText(query);
  const vectorScores = await vectorStore.searchVectorScores(
    index,
    queryEmbedding,
    RAG_RETRIEVAL_CONFIG.topK
  );
  const rankedChunks = rankVectorChunks(index.chunks, queryEmbedding, vectorScores.scores)
    .sort((left, right) => {
      if (right.similarity !== left.similarity) {
        return right.similarity - left.similarity;
      }

      return left.index - right.index;
    });

  return {
    index,
    queryEmbedding,
    chunks: rankedChunks.slice(0, RAG_RETRIEVAL_CONFIG.topK)
  };
}

/**
 * 学习点：这是增强版 Hybrid RAG。
 *
 * 当用户问“总结全文、分析整份文档、查知识库、多文档对比”时，
 * 只靠一次向量检索可能不够，所以这里会多做几步增强。
 *
 * 当前流程：
 * Query Enhancement -> Vector Search -> FTS5/BM25 ->
 * Score Fusion -> Rule-based Rerank -> Retrieval Validation。
 */
export async function searchHybridDocumentIndex(
  document: UploadedDocumentRecord,
  query: string
): Promise<HybridDocumentRetrievalResult> {
  const index = await getOrBuildVectorDocumentIndex(document);
  // 全文分析和普通问答的上下文选择策略不同：
  // 普通问答重相关性；全文分析还要尽量覆盖文档不同位置。
  const isWholeDocumentRequest = isWholeDocumentAnalysisRequest(query);
  // Query Enhancement 是给检索器看的，不是给用户看的。
  // 它会把文件名、全文分析提示等加入 query，提高召回稳定性。
  const enhancedQuery = enhanceRetrievalQuery(query, document);
  const queryEmbedding = await embeddingProvider.embedText(enhancedQuery);
  const queryTerms = extractTerms(enhancedQuery);
  // FTS5/BM25 是关键词检索信号，和向量检索互补。
  // 例如代码名、专有名词、页码、版本号这类内容，关键词检索通常更可靠。
  const bm25Scores = searchFtsBm25Scores(document.threadId, enhancedQuery);

  // 步骤 1：同时拿“向量检索结果”和“关键词检索结果”。
  // 向量检索擅长语义相似，BM25/FTS5 擅长精确词、编号、代码、术语。
  const vectorScores = await vectorStore.searchVectorScores(
    index,
    queryEmbedding,
    RAG_RETRIEVAL_CONFIG.hybridCandidateK
  );

  // 步骤 2：把不同检索信号融合成候选 chunk。
  const hybridCandidates = rankChunks(
    index.chunks,
    queryEmbedding,
    queryTerms,
    bm25Scores,
    vectorScores.scores
  )
    .sort((left, right) => {
      if (right.hybridScore !== left.hybridScore) {
        return right.hybridScore - left.hybridScore;
      }

      return left.index - right.index;
    })
    .slice(0, RAG_RETRIEVAL_CONFIG.rerankCandidateK);

  // 步骤 3：第一次融合后，还要 rerank。
  // rerank 的目的不是重新检索，而是把候选 chunk 再排得更合理。
  const rankedChunks = rerankChunks(hybridCandidates, queryTerms);

  // 步骤 4：如果用户要“全文总结”，不能只拿最相似的几个片段。
  // 所以这里会尽量覆盖文档不同位置，减少只看到局部的情况。
  const selectedChunks = isWholeDocumentRequest
    ? selectWholeDocumentContext(rankedChunks)
    : rankedChunks.slice(0, RAG_RETRIEVAL_CONFIG.topK);
  const bestHybridScore = selectedChunks[0]?.hybridScore ?? 0;
  const bestRerankScore = selectedChunks[0]?.rerankScore ?? 0;
  const matchedTermCount = new Set(
    selectedChunks.flatMap((chunk) => chunk.matchedTerms)
  ).size;

  // 步骤 5：Answer Validation 的前置判断。
  // 当前先用规则判断检索是否够用，后续可以换成模型验证。
  const isLikelySufficient =
    isWholeDocumentRequest ||
    bestHybridScore >= RAG_RETRIEVAL_CONFIG.minimumUsefulHybridScore ||
    matchedTermCount >= Math.min(3, queryTerms.length);

  return {
    index,
    queryEmbedding,
    queryTerms,
    enhancedQuery,
    chunks: selectedChunks,
    validation: {
      isWholeDocumentRequest,
      isLikelySufficient,
      bestHybridScore,
      bestRerankScore,
      matchedTermCount,
      retrievalStrategy: isWholeDocumentRequest
        ? "hybrid-rag-whole-document"
        : "hybrid-rag",
      note: isLikelySufficient
        ? "Retrieval passed hybrid relevance validation."
        : "Retrieved chunks may be weakly related; ask a narrower question or refine the query."
    }
  };
}

function rankChunks(
  chunks: VectorIndexedChunk[],
  queryEmbedding: number[],
  queryTerms: string[],
  bm25Scores: Map<number, number>,
  vectorScores: Map<number, number> = new Map()
): VectorSearchChunk[] {
  return chunks.map((chunk) => {
    // 一个 chunk 会同时拿到三类信号：
    // similarity：语义相似度；keywordScore：关键词覆盖；bm25Score：FTS5/BM25 精确命中。
    const matchedTerms = getMatchedTerms(chunk.content, queryTerms);
    const similarity =
      vectorScores.get(chunk.index) ?? cosineSimilarity(queryEmbedding, chunk.embedding);
    const keywordScore = calculateKeywordScore(chunk.content, queryTerms, matchedTerms);
    const bm25Score = bm25Scores.get(chunk.index) ?? 0;

    // 学习点：hybridScore 是把多种检索信号合成一个分数。
    // 这样既能照顾“语义像”，也能照顾“关键词精确命中”。
    const hybridScore = Number(
      (similarity * 0.55 + keywordScore * 0.2 + bm25Score * 0.25).toFixed(6)
    );

    return {
      ...chunk,
      similarity,
      keywordScore,
      bm25Score,
      hybridScore,
      rerankScore: hybridScore,
      matchedTerms
    };
  });
}

function rankVectorChunks(
  chunks: VectorIndexedChunk[],
  queryEmbedding: number[],
  vectorScores: Map<number, number> = new Map()
): VectorSearchChunk[] {
  return chunks.map((chunk) => {
    // 2-step 只使用向量相似度，所以其它分数置为 0。
    const similarity =
      vectorScores.get(chunk.index) ?? cosineSimilarity(queryEmbedding, chunk.embedding);

    return {
      ...chunk,
      similarity,
      keywordScore: 0,
      bm25Score: 0,
      hybridScore: similarity,
      rerankScore: similarity,
      matchedTerms: []
    };
  });
}

// 学习点：rerank 是“候选结果重排”。
// 当前项目先用规则版 rerank，后面如果接入专门的 reranker 模型，可以替换这里。
function rerankChunks(
  chunks: VectorSearchChunk[],
  queryTerms: string[]
): VectorSearchChunk[] {
  return chunks
    .map((chunk) => {
      // coverageScore 看 query 里的关键词有多少被当前 chunk 覆盖。
      // 这可以避免“语义像但关键术语没命中”的 chunk 排得太靠前。
      const coverageScore =
        queryTerms.length > 0
          ? chunk.matchedTerms.length / Math.min(queryTerms.length, 12)
          : 0;
      const headingBoost = /^#{1,4}\s|^\d+[.\u3001]\s|^第.+章|^第.+节/m.test(
        chunk.content
      )
        ? 0.04
        : 0;
      // 标题和靠前位置通常更可能包含结构性信息，所以给一点轻微加权。
      const lengthPenalty = chunk.charCount > RAG_RETRIEVAL_CONFIG.maxChunkCharacters
        ? 0.03
        : 0;
      const positionBoost = chunk.index <= 2 ? 0.02 : 0;
      const rerankScore = Number(
        (
          chunk.hybridScore * 0.65 +
          coverageScore * 0.2 +
          chunk.bm25Score * 0.1 +
          headingBoost +
          positionBoost -
          lengthPenalty
        ).toFixed(6)
      );

      return {
        ...chunk,
        rerankScore
      };
    })
    .sort((left, right) => {
      if (right.rerankScore !== left.rerankScore) {
        return right.rerankScore - left.rerankScore;
      }

      return left.index - right.index;
    });
}

function enhanceRetrievalQuery(
  query: string,
  document: UploadedDocumentRecord
): string {
  const fileNameContext = document.fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");

  // 学习点：短问题可能信息太少，所以给检索器补一点上下文。
  // 例如把文件名、整体分析提示加入 query，可以提高召回概率。
  const wholeDocumentHint = isWholeDocumentAnalysisRequest(query)
    ? "整体 总结 目录 章节 结构 重点 overview summary full document"
    : "";

  return [query, fileNameContext, wholeDocumentHint].filter(Boolean).join("\n");
}

function isWholeDocumentAnalysisRequest(query: string): boolean {
  const normalized = query.toLowerCase();
  return [
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
  ].some((keyword) => normalized.includes(keyword));
}

// 学习点：全文问题需要“覆盖面”，不是只拿最高分。
function selectWholeDocumentContext(chunks: VectorSearchChunk[]): VectorSearchChunk[] {
  const selected = new Map<number, VectorSearchChunk>();
  let usedCharacters = 0;

  // 先拿重排后最相关的 chunk，保证回答有直接依据。
  for (const chunk of chunks) {
    if (usedCharacters >= RAG_RETRIEVAL_CONFIG.wholeDocumentMaxContextCharacters) {
      break;
    }

    selected.set(chunk.index, chunk);
    usedCharacters += Math.min(
      chunk.content.length,
      RAG_RETRIEVAL_CONFIG.wholeDocumentChunkPreviewCharacters
    );
  }

  const stride = Math.max(1, Math.floor(chunks.length / RAG_RETRIEVAL_CONFIG.topK));

  // 再按间隔补一些不同位置的 chunk，避免全文总结只看到局部内容。
  for (let index = 0; index < chunks.length; index += stride) {
    if (usedCharacters >= RAG_RETRIEVAL_CONFIG.wholeDocumentMaxContextCharacters) {
      break;
    }

    const chunk = chunks[index];
    if (!chunk || selected.has(chunk.index)) {
      continue;
    }

    selected.set(chunk.index, chunk);
    usedCharacters += Math.min(
      chunk.content.length,
      RAG_RETRIEVAL_CONFIG.wholeDocumentChunkPreviewCharacters
    );
  }

  return [...selected.values()].sort((left, right) => left.index - right.index);
}

function searchFtsBm25Scores(threadId: string, query: string): Map<number, number> {
  // 如果 query 无法构造安全的 FTS5 查询，就跳过关键词检索，只使用向量信号。
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return new Map();
  }

  return vectorStore.searchKeywordScores(
    threadId,
    ftsQuery,
    RAG_RETRIEVAL_CONFIG.hybridCandidateK
  );
}

// 学习点：SQLite FTS5 的 MATCH 查询需要安全拼接。
// 这里把用户问题拆成多个词，再用 OR 连接起来做关键词检索。
function buildFtsQuery(query: string): string {
  const terms = extractTerms(query)
    .filter((term) => /^[a-z0-9_+-]+$/i.test(term) || term.length >= 2)
    .slice(0, RAG_RETRIEVAL_CONFIG.maxQueryTerms)
    .map((term) => `"${term.replace(/"/g, '""')}"`);

  return [...new Set(terms)].join(" OR ");
}

function markVectorIndexPersisted(threadId: string): void {
  // uploaded_documents.index_status 记录索引是否已完成，方便刷新页面或重启后恢复状态。
  sqliteDb
    .prepare(
      `
        UPDATE uploaded_documents
        SET index_status = 'indexed'
        WHERE thread_id = ?
      `
    )
    .run(threadId);
}

function extractTerms(text: string): string[] {
  const normalizedText = text.toLowerCase();
  const latinTerms = normalizedText.match(/[a-z0-9_+-]{2,}/g) ?? [];
  const cjkText = normalizedText.replace(/[^\u4e00-\u9fff]/g, "");
  const cjkTerms: string[] = [];

  // 学习点：中文不像英文有天然空格，所以这里用 bigram。
  // 例如“知识库”会拆出“知识”“识库”，用于简单关键词匹配。
  for (let index = 0; index < cjkText.length - 1; index += 1) {
    cjkTerms.push(cjkText.slice(index, index + 2));
  }

  return [...latinTerms, ...cjkTerms].filter(
    (term) => term.length >= MIN_TOKEN_LENGTH
  );
}

function getMatchedTerms(content: string, queryTerms: string[]): string[] {
  const normalizedContent = content.toLowerCase();
  return [...new Set(queryTerms.filter((term) => normalizedContent.includes(term)))].slice(
    0,
    RAG_RETRIEVAL_CONFIG.maxQueryTerms
  );
}

function calculateKeywordScore(
  content: string,
  queryTerms: string[],
  matchedTerms: string[]
): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  // coverage 解决“命中了几个词”，density 解决“命中频次高不高”。
  // 两者合并后作为 keywordScore，与向量相似度和 BM25 一起融合。
  const normalizedContent = content.toLowerCase();
  const coverageScore = matchedTerms.length / Math.min(queryTerms.length, 12);
  const densityScore =
    matchedTerms.reduce((score, term) => {
      const occurrences = normalizedContent.split(term).length - 1;
      return score + Math.min(occurrences, 3) * 0.04;
    }, 0) || 0;

  return Number(Math.min(1, coverageScore + densityScore).toFixed(6));
}

function cosineSimilarity(left: number[], right: number[]): number {
  // 当前 embedding 都已归一化，所以点积可以直接近似 cosine similarity。
  let dotProduct = 0;
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    dotProduct += left[index] * right[index];
  }

  return Number(dotProduct.toFixed(6));
}
