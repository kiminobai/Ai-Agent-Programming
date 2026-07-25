# RAG 文件上传、向量索引与上下文控制

这个功能的目的不是把上传文件直接发给模型，而是避免大文件占满 LLM 上下文。

当前流程：

`上传文件 -> 原始文件写入 data/uploads -> storage_key 写入 SQLite -> 提取纯文本 -> 绑定到 threadId -> 切分 chunks -> 为 chunks 建立向量索引 -> chunks 和 embedding 写入 SQLite -> 用户提出文件相关问题 -> 向量检索 Top-K chunks -> 模型基于少量相关片段回答`

## 为什么需要向量索引

只做切分还不等于 RAG。如果把前 20 个、前 50 个 chunk 都返回给模型，本质上还是不断往上下文里塞内容，文件稍大就会出现上下文超限。

RAG 的关键是“先检索，再生成”：

1. 后端把文档切成小块。
2. 每个 chunk 被转换成向量。
3. 查询问题也被转换成向量。
4. 后端计算 query 向量与 chunk 向量的余弦相似度。
5. 只返回 Top-K 个最相关 chunk。
6. LLM 只阅读这些相关片段并回答。

## 当前实现

- 上传支持 `.md`、`.markdown`、`.txt`、`.pdf`。
- 原始文件保存到 `data/uploads/{userId}/{threadId}/`。
- SQLite 的 `uploaded_documents` 表只保存文件元信息、相对 `storage_key`、解析文本和状态。
- 第一次检索时会自动建立当前文档的向量索引。
- chunks 和 embedding 会保存到 SQLite 的 `document_chunks` 表。
- 后续同一 `threadId` 会优先复用 SQLite 中已有的索引。
- 项目或电脑重启后，只要 SQLite 文件和 `data/uploads` 目录还在，上传文件和向量索引仍可恢复。
- 删除对话时，会删除该 thread 的对话记录、短期记忆、上传文件目录、文档记录和 RAG 索引。
- `chunkSize`、`chunkOverlap`、`topK`、向量维度都由后端配置。
- 工具名是 `retrieve_uploaded_document_chunks`。

## 当前向量化方式

当前项目使用本地轻量向量化：

- 英文、数字会按词提取。
- 中文会按 2 字滑动窗口提取。
- token 通过稳定 hash 映射到固定维度向量。
- 向量归一化后，用 cosine similarity 检索相关 chunk。

这样不依赖外部 embedding API，也不是 mock 数据，是真实可运行并且会持久化到 SQLite 的本地向量索引。

后续如果接入 embedding 模型，只需要替换 `src/rag/vectorDocumentIndex.ts` 里的 `embedText` 实现。

## 和 DeepSeek 的关系

当前 DeepSeek 负责 Chat、Agent 推理和 Tool Calling。

文档向量化目前由本地索引完成，因为 DeepSeek Chat API 不等同于 embedding API。这样可以先把 RAG 架构跑通，后续再把本地向量替换成专门的 embedding 模型。

## 相关文件

- `src/rag/documentChunkLab.ts`
- `src/rag/vectorDocumentIndex.ts`
- `src/rag/uploadFileStorage.ts`
- `src/rag/uploadedDocumentStore.ts`
- `src/tools/langchain/uploadedDocumentTool.ts`
- `src/agents/dynamicMemoryPromptMiddleware.ts`
- `src/server.ts`
- `client/main.tsx`
