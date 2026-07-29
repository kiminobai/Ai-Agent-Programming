import { appConfig, getProviderConfig } from "../config";
import { sqliteDb } from "../db/sqlite";
import { LangChainProvider } from "../providers/langChainProvider";
import { RAG_RETRIEVAL_CONFIG } from "./documentChunkLab";
import { searchHybridDocumentIndex, type HybridDocumentRetrievalResult } from "./vectorDocumentIndex";
import type { UploadedDocumentRecord } from "./uploadedDocumentStore";
import type { VectorDocumentIndex, VectorIndexedChunk } from "./vectorStore";

type GraphNode = {
  entity: string;
  entityType: "concept" | "term";
  chunkIndexes: number[];
  mentionCount: number;
};

type GraphEdge = {
  sourceEntity: string;
  targetEntity: string;
  relation: "co_occurs_with";
  weight: number;
  chunkIndexes: number[];
};

type GraphIndex = {
  threadId: string;
  builtAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphRagSearchMode =
  | "basic-search"
  | "local-search"
  | "global-search"
  | "drift-search"
  | "question-generation";

type GraphNodeRow = {
  entity: string;
  entity_type: GraphNode["entityType"];
  chunk_indexes_json: string;
  mention_count: number;
};

type GraphEdgeRow = {
  source_entity: string;
  target_entity: string;
  relation: GraphEdge["relation"];
  weight: number;
  chunk_indexes_json: string;
};

const MAX_ENTITIES_PER_CHUNK = 8;
const MAX_QUERY_ENTITIES = 6;
const MIN_RULE_ENTITIES_FOR_GRAPH = 3;

// 学习点：GraphRAG 的返回结果继承 Hybrid RAG。
// 原因是当前实现不是“单独建一套检索”，而是先用 Hybrid 召回，再用图谱补充相关 chunk。
export interface GraphRagRetrievalResult extends HybridDocumentRetrievalResult {
  graph: {
    searchMode: GraphRagSearchMode;
    matchedEntities: string[];
    expandedEntities: string[];
    expandedChunkIndexes: number[];
    generatedQuestions: string[];
  };
}

export async function searchGraphDocumentIndex(
  document: UploadedDocumentRecord,
  query: string
): Promise<GraphRagRetrievalResult> {
  // 学习点：GraphRAG 先复用 Hybrid RAG 的召回结果，再用实体关系图谱补充相邻 chunk。
  const hybrid = await searchHybridDocumentIndex(document, query);
  // 图谱构建比较贵，所以优先读 SQLite 里已经保存过的图谱；没有才重新构建。
  const graph = await getOrBuildGraphIndex(hybrid.index);
  // 同样是 GraphRAG，不同问题适合不同搜索模式：局部关系、全局概览、DRIFT、问题生成等。
  const searchMode = selectGraphSearchMode(query);
  const queryEntities = extractEntities(query).slice(0, MAX_QUERY_ENTITIES);
  const graphExpansion = searchGraphByMode(graph, hybrid.index, queryEntities, searchMode);
  const chunksByIndex = new Map<number, VectorIndexedChunk>(
    hybrid.index.chunks.map((chunk) => [chunk.index, chunk])
  );
  const existingChunks = new Map(
    hybrid.chunks.map((chunk) => [chunk.index, chunk])
  );

  for (const chunkIndex of graphExpansion.expandedChunkIndexes) {
    if (existingChunks.has(chunkIndex)) {
      const chunk = existingChunks.get(chunkIndex);
      if (chunk) {
        // 图谱命中的 chunk 不是重新算相似度，而是给它一个小的关系加权。
        // 这样既保留 Hybrid 原排序，又让关系链路相关内容有机会进入上下文。
        chunk.hybridScore = Number((chunk.hybridScore + 0.08).toFixed(6));
        chunk.rerankScore = Number((chunk.rerankScore + 0.08).toFixed(6));
      }
      continue;
    }

    const chunk = chunksByIndex.get(chunkIndex);
    if (!chunk) {
      continue;
    }

    existingChunks.set(chunk.index, {
      ...chunk,
      similarity: 0,
      keywordScore: 0,
      bm25Score: 0,
      hybridScore: 0.08,
      rerankScore: 0.08,
      matchedTerms: graphExpansion.matchedEntities
    });
  }

  const chunks = [...existingChunks.values()]
    .sort((left, right) => {
      if (right.rerankScore !== left.rerankScore) {
        return right.rerankScore - left.rerankScore;
      }

      return left.index - right.index;
    })
    .slice(0, RAG_RETRIEVAL_CONFIG.topK);

  return {
    ...hybrid,
    chunks,
    validation: {
      ...hybrid.validation,
      retrievalStrategy: "graph-rag",
      isLikelySufficient:
        hybrid.validation.isLikelySufficient || graphExpansion.expandedChunkIndexes.length > 0,
      note:
        graphExpansion.expandedChunkIndexes.length > 0
          ? `GraphRAG ${graphExpansion.searchMode} expanded retrieval through the document graph.`
          : `GraphRAG ${graphExpansion.searchMode} found no useful graph expansion, so Hybrid RAG results were used.`
    },
    graph: graphExpansion
  };
}

export function clearDocumentGraphIndex(threadId: string): void {
  // 删除对话或重新索引文件时，要同步清理图谱缓存，避免旧关系污染新文件。
  sqliteDb.prepare("DELETE FROM document_graph_edges WHERE thread_id = ?").run(threadId);
  sqliteDb.prepare("DELETE FROM document_graph_nodes WHERE thread_id = ?").run(threadId);
}

async function getOrBuildGraphIndex(index: VectorDocumentIndex): Promise<GraphIndex> {
  // 图谱节点和边会持久化到 SQLite；内存重启后仍可恢复。
  const persisted = loadGraphIndex(index.threadId);
  if (persisted) {
    return persisted;
  }

  const graph = await buildGraphIndex(index);
  saveGraphIndex(graph);
  return graph;
}

async function buildGraphIndex(index: VectorDocumentIndex): Promise<GraphIndex> {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  const builtAt = new Date().toISOString();

  for (const chunk of index.chunks) {
    // 学习点：每个 chunk 先抽实体，再用“同一 chunk 共现”建立轻量关系边。
    const entities = (await extractChunkEntities(chunk.content)).slice(
      0,
      MAX_ENTITIES_PER_CHUNK
    );

    for (const entity of entities) {
      const node: GraphNode = nodeMap.get(entity) ?? {
        entity,
        entityType: isMostlyAscii(entity) ? "term" : "concept",
        chunkIndexes: [],
        mentionCount: 0
      };
      node.mentionCount += countMentions(chunk.content, entity);
      if (!node.chunkIndexes.includes(chunk.index)) {
        node.chunkIndexes.push(chunk.index);
      }
      nodeMap.set(entity, node);
    }

    for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
        // 共现关系不是严格知识图谱三元组，只是学习版 GraphRAG 的轻量关系。
        // 它能帮助系统发现“经常在同一段出现”的相关概念。
        const [sourceEntity, targetEntity] = [entities[leftIndex], entities[rightIndex]].sort();
        const edgeKey = `${sourceEntity}\u0000${targetEntity}\u0000co_occurs_with`;
        const edge: GraphEdge = edgeMap.get(edgeKey) ?? {
          sourceEntity,
          targetEntity,
          relation: "co_occurs_with",
          weight: 0,
          chunkIndexes: []
        };
        edge.weight += 1;
        if (!edge.chunkIndexes.includes(chunk.index)) {
          edge.chunkIndexes.push(chunk.index);
        }
        edgeMap.set(edgeKey, edge);
      }
    }
  }

  return {
    threadId: index.threadId,
    builtAt,
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()]
  };
}

function saveGraphIndex(graph: GraphIndex): void {
  clearDocumentGraphIndex(graph.threadId);

  // 节点表保存：实体出现在哪些 chunk、出现次数是多少。
  const insertNode = sqliteDb.prepare(`
    INSERT INTO document_graph_nodes (
      thread_id,
      entity,
      entity_type,
      chunk_indexes_json,
      mention_count,
      built_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  // 边表保存：两个实体在哪些 chunk 里共同出现、共现权重是多少。
  const insertEdge = sqliteDb.prepare(`
    INSERT INTO document_graph_edges (
      thread_id,
      source_entity,
      target_entity,
      relation,
      weight,
      chunk_indexes_json,
      built_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = sqliteDb.transaction(() => {
    for (const node of graph.nodes) {
      insertNode.run(
        graph.threadId,
        node.entity,
        node.entityType,
        JSON.stringify(node.chunkIndexes),
        node.mentionCount,
        graph.builtAt
      );
    }

    for (const edge of graph.edges) {
      insertEdge.run(
        graph.threadId,
        edge.sourceEntity,
        edge.targetEntity,
        edge.relation,
        edge.weight,
        JSON.stringify(edge.chunkIndexes),
        graph.builtAt
      );
    }
  });

  transaction();
}

function loadGraphIndex(threadId: string): GraphIndex | null {
  const nodeRows = sqliteDb
    .prepare(
      `SELECT entity, entity_type, chunk_indexes_json, mention_count
       FROM document_graph_nodes
       WHERE thread_id = ?`
    )
    .all(threadId) as GraphNodeRow[];

  if (nodeRows.length === 0) {
    return null;
  }

  const edgeRows = sqliteDb
    .prepare(
      `SELECT source_entity, target_entity, relation, weight, chunk_indexes_json
       FROM document_graph_edges
       WHERE thread_id = ?`
    )
    .all(threadId) as GraphEdgeRow[];

  return {
    threadId,
    builtAt: new Date().toISOString(),
    nodes: nodeRows.map((row) => ({
      entity: row.entity,
      entityType: row.entity_type,
      chunkIndexes: parseNumberArray(row.chunk_indexes_json),
      mentionCount: row.mention_count
    })),
    edges: edgeRows.map((row) => ({
      sourceEntity: row.source_entity,
      targetEntity: row.target_entity,
      relation: row.relation,
      weight: row.weight,
      chunkIndexes: parseNumberArray(row.chunk_indexes_json)
    }))
  };
}

function searchGraphByMode(
  graph: GraphIndex,
  index: VectorDocumentIndex,
  queryEntities: string[],
  searchMode: GraphRagSearchMode
): GraphRagRetrievalResult["graph"] {
  // Basic Search 不额外扩展图谱，只保留 Hybrid 基础结果。
  // 这样可以统一走 GraphRAG 接口，但不强行扩大上下文。
  if (searchMode === "basic-search") {
    return {
      searchMode,
      matchedEntities: [],
      expandedEntities: [],
      expandedChunkIndexes: [],
      generatedQuestions: []
    };
  }

  if (searchMode === "global-search") {
    return expandGlobalGraph(graph, index, searchMode);
  }

  if (searchMode === "drift-search") {
    return expandDriftGraph(graph, index, queryEntities, searchMode);
  }

  if (searchMode === "question-generation") {
    const localExpansion = expandLocalGraph(graph, queryEntities, searchMode);
    return {
      ...localExpansion,
      generatedQuestions: generateGraphQuestions(graph, localExpansion.expandedEntities)
    };
  }

  return expandLocalGraph(graph, queryEntities, searchMode);
}

function expandLocalGraph(
  graph: GraphIndex,
  queryEntities: string[],
  searchMode: GraphRagSearchMode
): GraphRagRetrievalResult["graph"] {
  // Local Search：围绕用户问题里命中的实体，找它自己和相邻关系边对应的 chunk。
  const matchedEntities = graph.nodes
    .filter((node) =>
      queryEntities.some(
        (entity) => node.entity.includes(entity) || entity.includes(node.entity)
      )
    )
    .map((node) => node.entity);
  const expandedEntities = new Set<string>(matchedEntities);
  const expandedChunkIndexes = new Set<number>();

  for (const node of graph.nodes) {
    if (matchedEntities.includes(node.entity)) {
      node.chunkIndexes.forEach((chunkIndex) => expandedChunkIndexes.add(chunkIndex));
    }
  }

  for (const edge of graph.edges) {
    const touchesQueryEntity =
      matchedEntities.includes(edge.sourceEntity) ||
      matchedEntities.includes(edge.targetEntity);

    if (!touchesQueryEntity) {
      continue;
    }

    expandedEntities.add(edge.sourceEntity);
    expandedEntities.add(edge.targetEntity);
    edge.chunkIndexes.forEach((chunkIndex) => expandedChunkIndexes.add(chunkIndex));
  }

  return {
    searchMode,
    matchedEntities,
    expandedEntities: [...expandedEntities],
    expandedChunkIndexes: [...expandedChunkIndexes],
    generatedQuestions: []
  };
}

function expandGlobalGraph(
  graph: GraphIndex,
  index: VectorDocumentIndex,
  searchMode: GraphRagSearchMode
): GraphRagRetrievalResult["graph"] {
  // 学习点：Global Search 不围绕单个实体，而是看高频实体和文档不同位置的整体结构。
  const centralEntities = [...graph.nodes]
    .sort((left, right) => right.mentionCount - left.mentionCount)
    .slice(0, MAX_QUERY_ENTITIES);
  const expandedChunkIndexes = new Set<number>();
  const targetStep = Math.max(1, Math.floor(index.chunkCount / RAG_RETRIEVAL_CONFIG.topK));

  for (const entity of centralEntities) {
    entity.chunkIndexes.forEach((chunkIndex) => expandedChunkIndexes.add(chunkIndex));
  }

  for (let chunkIndex = 0; chunkIndex < index.chunkCount; chunkIndex += targetStep) {
    expandedChunkIndexes.add(chunkIndex);
  }

  return {
    searchMode,
    matchedEntities: centralEntities.map((node) => node.entity),
    expandedEntities: centralEntities.map((node) => node.entity),
    expandedChunkIndexes: [...expandedChunkIndexes],
    generatedQuestions: []
  };
}

function expandDriftGraph(
  graph: GraphIndex,
  index: VectorDocumentIndex,
  queryEntities: string[],
  searchMode: GraphRagSearchMode
): GraphRagRetrievalResult["graph"] {
  // 学习点：DRIFT 是“先全局定位，再局部深入”。
  const globalExpansion = expandGlobalGraph(graph, index, searchMode);
  const localExpansion = expandLocalGraph(graph, queryEntities, searchMode);
  const expandedEntities = new Set([
    ...globalExpansion.expandedEntities,
    ...localExpansion.expandedEntities
  ]);
  const expandedChunkIndexes = new Set([
    ...globalExpansion.expandedChunkIndexes,
    ...localExpansion.expandedChunkIndexes
  ]);

  return {
    searchMode,
    matchedEntities: localExpansion.matchedEntities.length
      ? localExpansion.matchedEntities
      : globalExpansion.matchedEntities,
    expandedEntities: [...expandedEntities],
    expandedChunkIndexes: [...expandedChunkIndexes],
    generatedQuestions: []
  };
}

function generateGraphQuestions(
  graph: GraphIndex,
  seedEntities: string[]
): string[] {
  // Question Generation：不是回答用户问题，而是根据图谱关系生成“下一步可以问什么”。
  const entities = seedEntities.length
    ? seedEntities
    : graph.nodes
        .slice()
        .sort((left, right) => right.mentionCount - left.mentionCount)
        .map((node) => node.entity);
  const questions: string[] = [];

  for (const entity of entities.slice(0, 5)) {
    const related = graph.edges
      .filter((edge) => edge.sourceEntity === entity || edge.targetEntity === entity)
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 2)
      .map((edge) =>
        edge.sourceEntity === entity ? edge.targetEntity : edge.sourceEntity
      );

    if (related.length > 0) {
      questions.push(`${entity} 和 ${related.join("、")} 之间是什么关系？`);
    } else {
      questions.push(`${entity} 在文档里的作用是什么？`);
    }
  }

  return [...new Set(questions)].slice(0, 5);
}

function selectGraphSearchMode(query: string): GraphRagSearchMode {
  const normalized = query.trim().toLowerCase();

  // 这里仍然用轻量关键词判断，避免每个 GraphRAG 请求都额外调用模型做 search mode 分类。
  if (includesAny(normalized, ["推荐问题", "生成问题", "可以问什么", "question generation"])) {
    return "question-generation";
  }

  if (includesAny(normalized, ["drift", "先整体", "再深入", "逐步深入", "全局到局部"])) {
    return "drift-search";
  }

  if (includesAny(normalized, ["全局", "整体关系", "总体关系", "主要主题", "全局结构", "global"])) {
    return "global-search";
  }

  if (includesAny(normalized, ["关系", "关联", "联系", "依赖", "影响", "链路", "因果", "为什么", "导致", "local"])) {
    return "local-search";
  }

  return "basic-search";
}

async function extractChunkEntities(text: string): Promise<string[]> {
  // hybrid 实体抽取策略：
  // 1. 先用本地规则抽取，速度快、不要 token。
  // 2. 如果规则结果足够，就直接使用。
  // 3. 如果规则结果太少，才调用 LLM 补全。
  const ruleEntities = extractEntities(text);

  if (appConfig.graphRag.entityExtractor === "rule") {
    return ruleEntities;
  }

  if (
    appConfig.graphRag.entityExtractor === "hybrid" &&
    isRuleEntityExtractionGoodEnough(ruleEntities)
  ) {
    return ruleEntities;
  }

  const llmEntities = await extractEntitiesWithLlm(text, ruleEntities);
  return mergeEntities(ruleEntities, llmEntities);
}

async function extractEntitiesWithLlm(
  text: string,
  ruleEntities: string[]
): Promise<string[]> {
  try {
    // 只有 GRAPH_RAG_ENTITY_EXTRACTOR=llm 或 hybrid 规则不足时才会走到这里。
    const provider = new LangChainProvider(
      appConfig.graphRag.extractorProvider,
      getProviderConfig(appConfig.graphRag.extractorProvider)
    );

    if (!provider.isAvailable()) {
      return [];
    }

    const response = await provider.sendChat(
      appConfig.graphRag.extractorModel,
      [
        "Extract key entities and concepts from this document chunk for GraphRAG indexing.",
        "Use the rule-based entities as hints, but remove noisy terms and add important missing concepts.",
        "Return strict JSON only with this shape: {\"entities\":[\"...\"]}.",
        "Use the original language. Keep each entity short. Return at most 12 entities.",
        "",
        "[Rule-based entities]",
        ruleEntities.join(", ") || "(none)",
        "",
        "[Document chunk]",
        text.slice(0, 2000)
      ].join("\n"),
      "You are a precise information extraction assistant. Return JSON only."
    );
    const parsed = JSON.parse(extractJsonObject(response)) as { entities?: unknown[] };

    return [...new Set(
      (parsed.entities ?? [])
        .map(String)
        .map((entity) => entity.trim())
        .filter((entity) => entity.length >= 2 && !isStopEntity(entity))
    )].slice(0, 12);
  } catch (error) {
    console.warn("GraphRAG LLM entity extraction failed, falling back to rule extraction:", error);
    return [];
  }
}

function isRuleEntityExtractionGoodEnough(entities: string[]): boolean {
  // 当前先用简单数量判断“够不够好”。
  // 后续如果要更严格，可以加入噪声词比例、重复率、实体类型覆盖等规则。
  const usefulEntities = entities.filter((entity) => entity.length >= 2);
  const hasEnoughEntities = usefulEntities.length >= MIN_RULE_ENTITIES_FOR_GRAPH;
  const hasNonAsciiEntity = usefulEntities.some((entity) => !isMostlyAscii(entity));
  const hasAsciiEntity = usefulEntities.some(isMostlyAscii);

  return hasEnoughEntities && (hasNonAsciiEntity || hasAsciiEntity);
}

function mergeEntities(ruleEntities: string[], llmEntities: string[]): string[] {
  // 合并时规则结果和模型结果都保留，但要去重、过滤停用词，并限制实体数量。
  return [...new Set([...ruleEntities, ...llmEntities])]
    .filter((entity) => entity.length >= 2 && !isStopEntity(entity))
    .slice(0, 12);
}

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM entity extraction did not return JSON.");
  }

  return value.slice(start, end + 1);
}

function extractEntities(text: string): string[] {
  // 本地规则抽取：英文按 token 抽取，中文按连续汉字片段抽取。
  // 它不理解语义，但足够做轻量图谱的初始实体候选。
  const normalized = text
    .replace(/[^\p{Script=Han}A-Za-z0-9_+\-#.]+/gu, " ")
    .trim();
  const candidates = new Set<string>();
  const asciiTerms = normalized.match(/[A-Za-z][A-Za-z0-9_+\-#.]{2,}/g) ?? [];
  const cjkTerms = normalized.match(/[\p{Script=Han}]{2,8}/gu) ?? [];

  for (const term of [...asciiTerms, ...cjkTerms]) {
    const candidate = term.trim();
    if (candidate.length >= 2 && !isStopEntity(candidate)) {
      candidates.add(candidate);
    }
  }

  return [...candidates];
}

function isStopEntity(entity: string): boolean {
  const lower = entity.toLowerCase();
  return [
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "一个",
    "这个",
    "那个",
    "什么",
    "怎么",
    "进行",
    "可以",
    "需要",
    "用户"
  ].includes(lower);
}

function countMentions(text: string, entity: string): number {
  return text.split(entity).length - 1 || 1;
}

function isMostlyAscii(value: string): boolean {
  return /^[\x00-\x7F]+$/.test(value);
}

function parseNumberArray(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as number[];
    return Array.isArray(parsed) ? parsed.filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function includesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}
