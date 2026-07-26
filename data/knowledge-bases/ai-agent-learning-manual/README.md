# AI Agent 学习手册知识库

这个目录用于存放同一份资料的不同版本文件。

## 推荐结构

```text
data/knowledge-bases/
└─ ai-agent-learning-manual/
   ├─ README.md
   ├─ AI_Agent学习手册_Task资料版_v8_RAG完整检索链路.pdf
   ├─ AI_Agent学习手册_Task资料版_v9_xxx.pdf
   └─ AI_Agent学习手册_Task资料版_v10_xxx.pdf
```

## 放文件的位置

把文件直接放到当前目录：

```text
data/knowledge-bases/ai-agent-learning-manual/
```

如果文件名里已经包含 `v8`、`v9` 这种版本号，就不需要再额外创建 `versions/v8/` 目录。

## 为什么这样放

`ai-agent-learning-manual` 表示一个知识库。

同一个知识库下可以直接放多个版本文件。

后续做索引时，系统可以从文件名里识别版本，也可以把版本信息保存到 SQLite 元数据里。
