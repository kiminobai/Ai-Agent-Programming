# RAG 知识点汇总

![当前项目 RAG 自动路由流程图](./rag-flow.png)

这份笔记是当前项目唯一的 RAG 学习文档。原来的 `rag-architecture-notes.md` 已合并到这里，避免同一套概念分散在多个文件里。

## 1. 先分清两个层级

RAG 系统里最容易混的是“怎么检索”和“从哪里检索”。

```text
architecture：这次 RAG 怎么执行
sourceScope：资料从哪里来
```

当前项目里的 architecture：

```text
2-step RAG
Agentic RAG
Hybrid RAG
GraphRAG
```

当前项目里的 sourceScope：

```text
uploaded-document：当前对话上传的文件
knowledge-base：长期知识库
multi-document：多文档 / 多版本资料
```

正确理解是：

```text
同一个知识库问题，可以走 Hybrid RAG，也可以走 GraphRAG。
同一个上传文件问题，可以走 2-step RAG，也可以走 Agentic RAG。
```

## 2. 2-step RAG

2-step RAG 是最简单、最低成本的固定流程：

```text
用户问题
  -> 检索一次相关文档片段
  -> 把片段放入 Prompt
  -> LLM 基于片段回答
```

适合：

```text
简单事实问答
解释某个概念
查找某个信息
用户没有要求全文分析或多步骤处理
```

当前项目对应：

```text
src/rag/vectorDocumentIndex.ts
searchVectorDocumentIndex()
```

默认策略：能用 2-step RAG 解决的问题，就不升级到更复杂、更耗 token 的链路。

## 3. Agentic RAG

Agentic RAG 的核心不是“检索更复杂”，而是：

```text
由 LLM Agent 决定是否调用检索工具、何时调用、调用几次。
```

流程：

```text
用户问题
  -> 进入 Agent
  -> Agent 判断是否需要工具
  -> Agent 调用文档检索工具或其他工具
  -> 工具返回资料
  -> Agent 继续推理
  -> 输出最终回答
```

适合：

```text
生成
改写
对比
继续处理
整理成表格
制定计划
多步骤任务
图片能力判断
```

当前项目对应：

```text
src/agents/langChainToolAgent.ts
src/tools/langchain/uploadedDocumentTool.ts
```

## 4. Hybrid RAG

Hybrid RAG 是增强版检索链路，重点是提高召回质量和答案可靠性。

当前项目里的 Hybrid RAG：

```text
用户问题
  -> 查询增强
  -> 生成 query embedding
  -> Chroma 向量检索
  -> SQLite FTS5 / BM25 关键词检索
  -> 分数融合
  -> Rerank 重排
  -> Retrieval Validation 检索质量验证
  -> LLM 生成回答
  -> Answer Validation 答案验证
```

适合：

```text
总结全文
分析整份资料
提取目录大纲
知识库问答
多文档 / 多版本资料检索
需要更稳召回的宽泛问题
```

当前项目对应：

```text
src/rag/vectorDocumentIndex.ts
searchHybridDocumentIndex()
```

## 5. GraphRAG

GraphRAG 是在文本片段检索之外，再加一层“实体关系图谱扩展”。

它关注的不是“哪个 chunk 最像用户问题”，而是：

```text
文档里有哪些关键概念？
这些概念出现在哪些 chunk？
哪些概念经常一起出现？
用户问某个概念时，是否应该带出相邻概念和相关 chunk？
```

当前项目里的 GraphRAG 是轻量学习版：

```text
1. 文档正常切 chunk
2. chunk 正常做 embedding / Chroma / SQLite FTS5
3. 从 chunk 文本里抽取实体词
4. 同一 chunk 中共同出现的实体形成关系边
5. 实体节点和关系边写入 SQLite
6. 用户问关系、依赖、影响、链路、因果时路由到 GraphRAG
7. GraphRAG 先复用 Hybrid RAG，再用图谱扩展相关 chunk
8. 最后仍由 LLM 基于检索上下文回答
```

当前支持的 GraphRAG Search Mode：

```text
Basic Search：保留 Hybrid RAG 基础结果
Local Search：围绕命中的实体做局部关系扩展
Global Search：从高频实体和文档不同位置看整体结构
DRIFT Search：先全局定位，再局部深入
Question Generation：根据实体关系生成可继续追问的问题
```

当前项目对应：

```text
src/rag/graphRag.ts
src/rag/ragArchitectureRouter.ts
src/rag/knowledgeBaseRetriever.ts
src/db/sqlite.ts
```

## 6. 自动选择规则

当前项目不是固定使用某一种 RAG，而是根据用户当前对话自动选择最合适的路径。

路由顺序：

```text
1. 如果是图片：走 Agentic，让模型能力判断是否支持视觉理解
2. 如果关键词明确：直接判断，不额外做 embedding 意图判断
3. 如果关键词不明确：用 embedding 做语义相似度兜底
4. 如果仍不明确：默认回到最低成本的 2-step RAG
```

自动选择表：

```text
简单问答 -> 2-step RAG
全文总结 / 整体分析 -> Hybrid RAG
关系 / 依赖 / 因果 / 链路 -> GraphRAG
生成 / 改写 / 对比 / 多步骤任务 -> Agentic RAG
知识库 / 多文档 -> 先确定 sourceScope，再按同一套规则选 architecture
```

这样做的目标：

```text
能用低成本路径解决的问题，不升级到高成本路径。
需要更强检索能力的问题，才使用 Hybrid 或 GraphRAG。
需要模型自己调工具的问题，才使用 Agentic。
```

当前项目对应：

```text
src/rag/ragArchitectureRouter.ts
selectDocumentRagArchitecture()
selectKnowledgeBaseRagArchitecture()
```

## 7. Embedding

Embedding 是把文本变成数字向量：

```text
文本 -> number[]
```

它不是“给 AI 看”，而是让计算机可以比较语义相似度。

例子：

```text
“RAG 是检索增强生成”
“先查资料再让模型回答”
```

这两句话字面不同，但语义接近。Embedding 会让它们在向量空间里距离更近。

当前项目里 Embedding 用在两个地方：

```text
1. 文档检索：比较用户问题和文档 chunk 是否相似
2. 路由兜底：关键词不明确时，判断问题更像哪种 RAG 意图
```

当前项目对应：

```text
src/rag/embeddingProvider.ts
```

配置示例：

```env
EMBEDDING_PROVIDER=siliconflow
EMBEDDING_MODEL=BAAI/bge-m3
```

## 8. GraphRAG 实体抽取

GraphRAG 需要先知道文档里的“实体 / 概念”是什么。

当前项目默认：

```env
GRAPH_RAG_ENTITY_EXTRACTOR=hybrid
```

含义：

```text
先使用本地规则抽取实体
如果规则结果已经足够，就不调用模型
如果规则结果太少或质量不足，再调用模型补全
这样既保留低成本，又能在必要时提高图谱质量
```

可选模式：

```text
hybrid：默认推荐，规则优先，必要时模型补全
rule：只用本地规则，不额外消耗模型 token
llm：只用模型抽取，质量更高但成本也更高
```

模型补全配置：

```env
GRAPH_RAG_EXTRACTOR_PROVIDER=deepseek
GRAPH_RAG_EXTRACTOR_MODEL=deepseek-v4-flash
```

注意：`hybrid` 不是每个 chunk 都调用模型。它会先跑算法，只有算法结果不足时才调用模型。

## 9. Chroma

Chroma 是向量数据库。

当前项目用它保存和检索 chunk embedding：

```text
data/chroma/
```

启动：

```powershell
npm run chroma
```

相关代码：

```text
src/rag/chromaVectorStore.ts
src/rag/vectorStoreProvider.ts
```

## 10. SQLite / FTS5 / BM25

SQLite 负责保存：

```text
对话记录
上传文件元数据
知识库文件元数据
chunk fallback
FTS5 / BM25 关键词检索索引
GraphRAG 节点和边
LangGraph checkpoint
长期用户偏好
```

FTS5 是 SQLite 的全文检索能力。

BM25 是关键词相关性排序算法。

它们负责补足向量检索的不足：

```text
向量检索擅长语义相似
BM25 擅长精确关键词命中
```

## 11. Rerank

Rerank 是重排。

当前项目不是模型 reranker，而是规则重排：

```text
hybridScore
关键词覆盖率
BM25 分数
标题加权
位置加权
长度惩罚
```

相关代码：

```text
src/rag/vectorDocumentIndex.ts
rerankChunks()
```

## 12. Retrieval Validation

Retrieval Validation 是检索质量验证。

它发生在模型回答之前，检查“检索出来的 chunk 是否足够支撑这次回答”。

当前项目会根据这些信号判断：

```text
是否是全文分析请求
bestHybridScore 是否达到最低可用分数
matchedTermCount 是否覆盖了足够多的查询关键词
```

作用：

```text
避免把弱相关 chunk 直接塞给模型
发现检索结果可能不够时，给后续回答更谨慎的信号
为 Answer Validation 提供前置判断
```

相关代码：

```text
src/rag/vectorDocumentIndex.ts
searchHybridDocumentIndex()
validation.isLikelySufficient
```

注意：Retrieval Validation 和 Answer Validation 不是一回事。

```text
Retrieval Validation：回答前，验证检索结果够不够好。
Answer Validation：回答后，验证模型答案是否被上下文支持。
```

## 13. Answer Validation

Answer Validation 是答案验证。

作用：

```text
检查回答是否被检索上下文支持
避免模型把没检索到的内容说得太肯定
必要时让回答变得更谨慎
```

相关代码：

```text
src/server.ts
validateDocumentAnswer()
```

## 14. 文件存储

用户上传文件：

```text
data/uploads/{userId}/{threadId}/
```

长期知识库文件：

```text
data/knowledge-bases/{knowledgeBaseId}/
```

数据库只保存相对路径 `storageKey`，不保存绝对路径，也不保存 `127.0.0.1` 这类 URL。

## 15. 常用命令

启动 Chroma：

```powershell
npm run chroma
```

构建知识库索引：

```powershell
npm run kb:index
```

启动项目：

```powershell
npm start
```

类型检查：

```powershell
npx.cmd tsc --noEmit
```

## 16. 一句话记忆

```text
2-step RAG：固定检索一次，再回答。
Agentic RAG：Agent 决定是否调用检索工具。
Hybrid RAG：检索链路加入增强、融合、重排、Retrieval Validation。
GraphRAG：在文本检索之外加入实体关系图谱扩展。
Answer Validation：模型回答后检查答案是否被检索上下文支持。
sourceScope：只表示资料从哪里来，不是 RAG 架构。
```
