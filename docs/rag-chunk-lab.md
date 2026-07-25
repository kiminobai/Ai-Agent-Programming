# RAG 文件上传与上下文控制

这个功能的目的不是把上传文件“直接发给模型”，而是避免大文件占满 LLM 上下文。

当前项目采用的流程是：

`上传文件 -> 提取纯文本 -> 绑定到 threadId -> 用户要求使用文件内容 -> Agent 调用 retrieve_uploaded_document_chunks -> 检索相关 chunks -> 模型基于少量相关 chunks 回答`

## 为什么不是直接切分后全部读取

只做切分还不等于 RAG。如果把前 20 个、前 50 个 chunk 都返回给模型，本质上还是在不断往上下文里塞内容，文件稍大就会出现上下文超限。

RAG 的关键是“按问题检索”，也就是：

1. 后端先把文档切成小块。
2. 用户提出具体问题。
3. 工具根据问题给每个 chunk 打分。
4. 只返回 Top-K 个最相关 chunk。
5. 模型只阅读这些相关片段并回答。

## 当前实现

- 上传支持 `.md`、`.markdown`、`.txt`、`.pdf`。
- 文件上传后只存到当前 `threadId`，不会立刻进入模型上下文。
- `chunkSize`、`chunkOverlap`、`topK` 都由后端配置，前端不暴露这些参数。
- 当用户说“分析这个文件”“读取文件”“总结文档”“基于文档回答”时，Agent 才会调用工具。
- 工具名是 `retrieve_uploaded_document_chunks`，职责是检索相关片段，不是返回整份文档。

## 重要限制

当前版本是轻量关键词检索，还不是向量数据库检索。

它已经能避免“整份文档塞进上下文”的问题，但如果后续要做更标准的 RAG，可以继续升级为：

- Embedding 模型生成向量。
- SQLite 或向量库保存 chunk metadata 与 embedding。
- 根据用户问题做语义相似度检索。
- 支持跨会话、跨文档、多文件检索。

## 相关文件

- `client/main.tsx`
- `src/server.ts`
- `src/rag/documentChunkLab.ts`
- `src/rag/uploadedDocumentStore.ts`
- `src/tools/langchain/uploadedDocumentTool.ts`
- `src/agents/dynamicMemoryPromptMiddleware.ts`
