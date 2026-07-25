# 基于文档的问答接口

这是项目里的第一个独立 RAG QA 接口。它不会要求前端把文档内容发给模型，而是后端根据 `threadId` 找到该对话上传的文档，检索相关 chunks，再让模型基于检索结果回答。

## 接口

```http
POST /api/documents/qa
Content-Type: application/json
```

## 请求体

```json
{
  "userId": "current-user-id",
  "threadId": "current-thread-id",
  "modelId": "deepseek-v4-flash",
  "roleId": "python-engineer",
  "question": "这份文档主要讲了什么？"
}
```

## 后端流程

1. 校验 `userId`、`threadId`、`modelId`、`question`。
2. 从 SQLite 读取当前 thread 绑定的上传文档。
3. 如果文档还没有向量索引，就切分并建立本地向量索引。
4. 用问题向量检索 Top-K 文档片段。
5. 把检索片段作为上下文交给模型。
6. 返回回答和 sources。

## 返回示例

```json
{
  "answer": "文档主要介绍了 AI Agent 的学习阶段和工具调用流程。\n\nSources: chunk 0, chunk 3",
  "document": {
    "fileId": "xxx",
    "fileName": "agent-notes.pdf",
    "fileType": "pdf",
    "storageKey": "user/thread/file-agent-notes.pdf",
    "parseStatus": "parsed",
    "indexStatus": "indexed"
  },
  "retrieval": {
    "strategy": "local-vector-cosine",
    "topK": 4,
    "totalChunks": 20,
    "sources": [
      {
        "chunkIndex": 0,
        "similarity": 0.42,
        "startChar": 0,
        "endChar": 800,
        "matchedTerms": ["文档", "主要"]
      }
    ]
  }
}
```

## 当前限制

- 目前支持基于 `.md`、`.markdown`、`.txt`、`.pdf` 的文本问答。
- PPT、图片会保存原始文件，但暂时没有 OCR 或 PPT 文本解析。
- 当前向量化是本地 hash 向量，后续可以替换成真正的 embedding 模型。
