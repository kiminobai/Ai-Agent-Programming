# RAG 知识点汇总

![当前项目 RAG 流程图](./rag-flow.png)

这份文档按 LangChain 官方 RAG architectures 的顺序整理，避免把不同层级的概念混在一起。

## 1. 官方三种 RAG Architecture

LangChain 官方把 RAG architectures 分成三类，并且这三类是同一个层级：

```text
1. 2-step RAG
2. Agentic RAG
3. Hybrid RAG
```

不要把 `knowledge-base`、`multi-document`、`uploaded-document` 当成和它们同层级的架构。

## 2. 2-step RAG

2-step RAG 是固定流程：

```text
用户问题
  -> 后端先检索相关文档片段
  -> 把片段放进 Prompt
  -> LLM 基于片段生成回答
```

特点：

```text
快
简单
可控
延迟稳定
适合明确问答
```

当前项目对应：

```text
src/rag/vectorDocumentIndex.ts
searchVectorDocumentIndex()
```

## 3. Agentic RAG

Agentic RAG 的关键是：

```text
由 LLM Agent 决定什么时候检索、怎么检索、是否继续调用工具。
```

它不是固定先检索，而是：

```text
用户问题
  -> 进入 Agent
  -> Agent 判断是否需要外部资料
  -> Agent 选择并调用检索工具
  -> 工具返回资料
  -> Agent 继续推理
  -> Agent 输出最终回答
```

特点：

```text
灵活
适合多步骤任务
可以组合多个工具
延迟不固定
控制性低于 2-step
```

当前项目对应：

```text
src/agents/langChainToolAgent.ts
src/tools/langchain/uploadedDocumentTool.ts
```

注意：

```text
Agentic RAG 看的是“谁决定调用工具”。
如果是 Agent 自己决定是否调用检索工具，就是 Agentic RAG。
```

## 4. Hybrid RAG

Hybrid RAG 是更强的检索链路，通常包含：

```text
Query Enhancement
Vector Search
Keyword Search / BM25
Score Fusion
Rerank
Retrieval Validation
Answer Validation
```

当前项目里的 Hybrid RAG：

```text
用户问题
  -> 查询增强
  -> 生成 query embedding
  -> Chroma 向量检索
  -> SQLite FTS5 / BM25 关键词检索
  -> 融合排序
  -> Rerank 重排
  -> 检索质量验证
  -> LLM 生成回答
  -> 答案验证
```

特点：

```text
比 2-step 更稳
比 Agentic 更可控
适合宽泛问题、全文分析、质量校验场景
```

当前项目对应：

```text
src/rag/vectorDocumentIndex.ts
searchHybridDocumentIndex()
```

## 5. 资料来源不是 Architecture

下面这些只是资料范围，也就是 `sourceScope`：

```text
uploaded-document：当前对话上传的文件
knowledge-base：长期知识库
multi-document：多文档 / 多版本资料
```

它们不是 RAG architecture。

正确写法：

```ts
architecture: "2-step-rag" | "agentic-rag" | "hybrid-rag";
sourceScope: "uploaded-document" | "knowledge-base" | "multi-document";
```

示例：

```text
当前上传文件 + 默认问答
architecture = 2-step-rag
sourceScope = uploaded-document

当前上传文件 + 多步骤任务
architecture = agentic-rag
sourceScope = uploaded-document

当前上传文件 + 总结整份文档
architecture = hybrid-rag
sourceScope = uploaded-document

知识库问答
architecture = hybrid-rag
sourceScope = knowledge-base

多版本资料对比
architecture = hybrid-rag
sourceScope = multi-document
```

当前项目的默认策略：

```text
普通文件问答默认走 2-step-rag。
只有明确要求总结全文、分析整份、目录大纲时，才走 hybrid-rag。
只有明确要求生成、对比、改写、继续、多步骤处理时，才走 agentic-rag。
```

自动判断不是只靠关键词。

当前项目路由顺序是：

```text
1. 先用明确关键词判断
2. 关键词没命中时，用 embedding 做语义相似度兜底
3. 如果语义也不够明确，默认回到 2-step-rag
```

这里的 embedding 不是“给 AI 看”，而是把用户问题变成计算机可以比较的数字向量：

```text
用户问题 -> embedding 向量 -> 和 Agentic/Hybrid 意图样例向量比较相似度
```

如果用户没写“总结”这个关键词，但语义很像“概括整份文档”，就可以自动升级到 `hybrid-rag`。

如果用户没写“生成”这个关键词，但语义很像“根据文档产出计划/表格/步骤”，就可以自动升级到 `agentic-rag`。

## 6. Embedding

Embedding 是把文本变成数字向量：

```text
文本 -> number[]
```

作用是让系统可以计算“语义相似度”。

例子：

```text
“RAG 是检索增强生成”
“先查资料再让模型回答”
```

这两句话字面不同，但语义接近。Embedding 会让它们在向量空间里距离更近。

当前项目：

```text
src/rag/embeddingProvider.ts
```

当前配置：

```env
EMBEDDING_PROVIDER=siliconflow
EMBEDDING_MODEL=BAAI/bge-m3
```

## 7. Chroma

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

## 8. SQLite / FTS5 / BM25

SQLite 负责保存：

```text
对话记录
上传文件元数据
知识库文件元数据
chunk fallback
FTS5 / BM25 关键词检索索引
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

相关代码：

```text
src/db/sqlite.ts
src/rag/sqliteVectorStore.ts
```

## 9. Chunk

Chunk 是文档切分后的小片段。

当前项目后端配置：

```ts
chunkSize: 800
chunkOverlap: 120
topK: 6
```

普通用户前端不需要看到这些参数。

相关代码：

```text
src/rag/documentChunkLab.ts
```

## 10. Rerank

Rerank 是重排。

当前项目不是模型 reranker，而是算法规则重排：

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

## 11. Answer Validation

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

## 12. 文件存储

用户上传文件：

```text
data/uploads/{userId}/{threadId}/
```

长期知识库文件：

```text
data/knowledge-bases/{knowledgeBaseId}/
```

数据库只保存相对路径 `storageKey`，不保存绝对路径，也不保存 `127.0.0.1` 这类 URL。

## 13. 常用命令

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

## 14. 一句话记忆

```text
2-step RAG：固定先检索，再回答。
Agentic RAG：Agent 自己决定是否调用检索工具。
Hybrid RAG：检索链路加入增强、融合、重排、验证。
```

这三个才是同一个层级。
