# RAG 完整流程图

下面这张图展示了一个相对完整的 RAG（Retrieval-Augmented Generation，检索增强生成）链路，包含离线索引构建、在线检索生成、结果回流优化三部分。

```mermaid
flowchart TD
    subgraph A[离线知识准备 / Indexing]
        A1[原始数据源\nPDF / Word / Web / DB / API / Markdown]
        A2[文档采集与导入\nLoaders / ETL]
        A3[文本解析与清洗\n去噪 / 去重 / 结构化]
        A4[切分 Chunking\n按字数 / 语义 / 段落]
        A5[元数据补充\n标题 / 来源 / 时间 / 标签 / 权限]
        A6[向量化 Embedding]
        A7[索引存储\nVector DB / BM25 / Hybrid Index]

        A1 --> A2 --> A3 --> A4 --> A5 --> A6 --> A7
    end

    subgraph B[在线问答 / Retrieval + Generation]
        B1[用户问题]
        B2[会话上下文读取\n短期记忆 / 长期记忆 / 用户偏好]
        B3[查询理解与改写\n意图识别 / Query Rewrite]
        B4[查询向量化]
        B5[检索器 Retriever\n向量检索 / 关键词检索 / 混合检索]
        B6[候选结果集合]
        B7[结果过滤\n权限过滤 / 时间过滤 / 去重]
        B8[重排 Rerank\n按相关性重新排序]
        B9[上下文组装\nTop-K Chunk + Metadata + History]
        B10[提示词构建\nSystem Prompt + Context + User Query]
        B11[LLM 生成答案]
        B12[答案输出\n附引用 / 来源 / 置信说明]

        B1 --> B2 --> B3 --> B4 --> B5
        A7 --> B5
        B5 --> B6 --> B7 --> B8 --> B9 --> B10 --> B11 --> B12
    end

    subgraph C[结果回流与持续优化]
        C1[用户反馈\n有帮助 / 无帮助 / 继续追问]
        C2[日志与观测\nQuery / Recall / Latency / Tool Trace]
        C3[召回质量评估\n命中率 / 覆盖率 / Top-K 质量]
        C4[提示词优化\nPrompt / Role / Output Contract]
        C5[知识库更新\n新增文档 / 重新切分 / 重建索引]
        C6[记忆写入\n偏好 / 事实 / 任务状态]

        B12 --> C1
        B12 --> C2
        C1 --> C3 --> C4
        C1 --> C6
        C2 --> C3
        C3 --> C5
        C5 --> A2
    end
```

## 阅读顺序

1. 先看左边离线阶段：把原始知识处理成可检索的索引。
2. 再看中间在线阶段：用户问题进入后，先结合上下文，再去检索，再让 LLM 基于检索结果生成答案。
3. 最后看右边优化阶段：把用户反馈、日志、记忆写回系统，用于持续优化召回和回答质量。

## 关键模块解释

- `Loader / ETL`：负责把 PDF、网页、数据库、API 等外部内容接入系统。
- `Chunking`：把长文档拆成适合检索的小片段，避免上下文过长或召回粒度过粗。
- `Embedding`：把文本转成向量，供向量检索使用。
- `Retriever`：根据用户问题从索引里找出最相关的知识片段。
- `Rerank`：对初步召回结果再次排序，提升最终送给 LLM 的上下文质量。
- `Prompt Builder`：把系统角色、用户问题、历史对话、召回内容拼成最终提示词。
- `Memory`：既可以读取短期对话上下文，也可以读取长期用户偏好与事实。

## 在 Agent 系统里的典型位置

- `RAG` 负责“找知识”。
- `Tool Calling` 负责“调用外部能力”。
- `Memory` 负责“记住上下文和偏好”。
- `LLM / Agent` 负责“理解问题、决定流程、生成答案”。

如果把它们组合起来，一个完整 Agent 常见链路就是：

`用户问题 -> Agent 判断 -> 需要知识时走 RAG -> 需要能力时调 Tool -> 结合 Memory -> LLM 输出答案`
