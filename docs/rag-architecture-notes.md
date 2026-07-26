# RAG Architectures 学习笔记

这份文档按 LangChain 官方顺序整理，并同步当前项目的真实实现。

## 1. 官方三种 RAG Architecture

LangChain 官方这一层级只有三种 RAG architecture：

```text
1. 2-step RAG
2. Agentic RAG
3. Hybrid RAG
```

这三种是同一个层级。

不要把下面这些混进 architecture 层级：

```text
uploaded-document
knowledge-base
multi-document
```

它们只是资料来源范围，也就是 `sourceScope`。

## 2. 2-step RAG

2-step RAG 是最简单的固定流程：

```text
用户问题
  -> 检索一次相关文档片段
  -> 把片段放进 Prompt
  -> LLM 生成回答
```

特点：

```text
最快
最简单
最可控
最适合普通用户直接问答
```

当前项目默认优先使用 `2-step-rag`。

也就是说，只要用户不是明确要总结全文、生成内容、对比、多步骤处理，就先走 2-step。

当前项目对应代码：

```text
src/rag/vectorDocumentIndex.ts
searchVectorDocumentIndex()
```

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
  -> Agent 调用文档检索工具
  -> 工具返回资料
  -> Agent 继续推理
  -> 输出最终回答
```

当前项目在这些情况会使用 `agentic-rag`：

```text
生成
对比
改写
继续
计划
步骤
流程
表格
多轮处理
图片能力判断
```

例子：

```text
根据这份文档生成学习计划
对比里面几个方案
把文档内容整理成表格
继续刚才的分析
```

当前项目对应代码：

```text
src/agents/langChainToolAgent.ts
src/tools/langchain/uploadedDocumentTool.ts
```

注意：

```text
Agentic RAG 看的是“谁决定调用工具”。
如果是 Agent 决定是否调用检索工具，就是 Agentic RAG。
```

## 4. Hybrid RAG

Hybrid RAG 是增强版检索链路。

它不是 Agentic RAG。

它关注的是检索质量控制：

```text
Query Enhancement
Vector Search
Keyword Search / BM25
Score Fusion
Rerank
Retrieval Validation
Answer Validation
```

当前项目在这些情况会使用 `hybrid-rag`：

```text
总结全文
分析整份文档
概览资料
查看目录大纲
需要更宽范围检索
知识库问答
多文档 / 多版本资料检索
```

当前项目对应代码：

```text
src/rag/vectorDocumentIndex.ts
searchHybridDocumentIndex()
```

## 5. 当前项目怎么自动判断

当前项目不是单纯靠关键词，也不是每次都让 LLM 判断。

当前判断顺序是：

```text
1. 先用明确关键词快速判断
2. 如果关键词没命中，再用 embedding 做语义相似度判断
3. 如果语义也不够明确，默认使用 2-step-rag
```

为什么要默认 2-step？

```text
普通用户最常见的需求是：问一个问题，马上得到答案。
2-step-rag 最快、最简单、成本最低。
```

为什么还要 embedding？

因为用户不一定刚好说中关键词。

比如用户可能不说“总结”，而是说：

```text
给我概览一下这份资料
帮我看看这份文件主要讲什么
```

这些语义接近“总结全文”，embedding 可以帮助路由器判断它更像 `hybrid-rag`。

再比如用户可能不说“生成”，而是说：

```text
基于文件产出一份学习路线
把里面的信息变成执行步骤
```

这些语义接近“多步骤产出”，embedding 可以帮助路由器判断它更像 `agentic-rag`。

当前项目对应代码：

```text
src/rag/ragArchitectureRouter.ts
selectDocumentRagArchitecture()
selectBySemanticSimilarity()
```

## 6. Embedding 在路由里做什么

Embedding 不是“把问题给 AI 看”。

它是把用户问题变成数字向量：

```text
用户问题 -> number[]
```

然后和预设意图样例做相似度比较：

```text
用户问题向量
  -> 对比 Agentic 意图样例向量
  -> 对比 Hybrid 意图样例向量
  -> 判断更像哪一种
```

当前项目里有两组语义样例：

```text
AGENTIC_EXAMPLES
HYBRID_EXAMPLES
```

如果用户问题和 Agentic 样例更像，就升级到 `agentic-rag`。

如果用户问题和 Hybrid 样例更像，就升级到 `hybrid-rag`。

如果都不够像，就保持默认 `2-step-rag`。

## 7. sourceScope 不是 Architecture

`sourceScope` 只表示资料从哪里来。

```text
uploaded-document：当前对话上传的文件
knowledge-base：长期知识库
multi-document：多文档 / 多版本资料
```

当前代码里正确拆分为：

```ts
architecture: "2-step-rag" | "agentic-rag" | "hybrid-rag";
sourceScope: "uploaded-document" | "knowledge-base" | "multi-document";
```

示例：

```text
普通文件问答
architecture = 2-step-rag
sourceScope = uploaded-document

文件生成计划
architecture = agentic-rag
sourceScope = uploaded-document

总结整份文档
architecture = hybrid-rag
sourceScope = uploaded-document

知识库问答
architecture = hybrid-rag
sourceScope = knowledge-base

多版本资料检索
architecture = hybrid-rag
sourceScope = multi-document
```

## 8. 一句话记忆

```text
2-step RAG：固定检索一次，再回答。
Agentic RAG：Agent 决定是否调用检索工具。
Hybrid RAG：检索链路加入增强、融合、重排、验证。
```

当前项目默认：

```text
普通问题 -> 2-step-rag
多步骤产出 -> agentic-rag
全文/宽范围分析 -> hybrid-rag
```
