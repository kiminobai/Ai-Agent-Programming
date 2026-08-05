# Chat 与 Work 存储边界

## Chat 模式

Chat 面向普通对话，继续使用服务端数据：

- 用户、登录信息和长期记忆保存在服务端 SQLite。
- 对话、LangGraph 短期记忆和 checkpoint 保存在服务端 SQLite。
- 上传文件、文档索引和知识库由服务端管理。

## Work 模式

Work 面向当前电脑上的 Agent 开发任务，数据保存在系统“文档/KimiBai”：

```text
KimiBai/
├─ data/
│  └─ work.sqlite
├─ tasks/
│  └─ <threadId>/
│     ├─ uploads/
│     ├─ generated/
│     ├─ extracted/
│     └─ temp/
├─ indexes/
│  └─ <threadId>/
└─ default-workspace/
```

- `work.sqlite` 保存工作任务列表、LangGraph checkpoint、短期/长期记忆、审批、子代理和文件活动。
- 工作附件与临时文件按 `threadId` 隔离，不进入服务端上传目录。
- 多个 Agent 任务可以指向同一个用户工作目录，但各自的状态不会混合。
- 未选择目录时使用 `default-workspace`。

## 删除规则

删除 Chat 对话时，只删除服务端对应记录与云端附件。

删除 Work 任务时，删除 `work.sqlite` 中该任务的数据，以及 `tasks/<threadId>`、`indexes/<threadId>`。用户主动选择的工作目录及 Agent 已写入其中的源码文件不会被删除。
