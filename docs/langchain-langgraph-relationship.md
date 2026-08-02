# LangChain 与 LangGraph 的关系

## 核心关系

```text
LangChain
提供构建 LLM 应用和 Agent 的高层组件
Model / Prompt / Tool / Middleware / createAgent
                    │
                    │ createAgent 底层使用
                    ▼
LangGraph
提供 Workflow 和 Agent 的图编排运行时
State / Node / Edge / Persistence / Streaming / Interrupt
```

一句话概括：

> **LangChain 负责组装模型、Prompt 和工具；LangGraph 负责控制这些能力按照什么流程执行，并保存执行状态。**

## 两者分别负责什么

| LangChain | LangGraph |
| --- | --- |
| 调用不同厂商的模型 | 使用 State 保存工作流数据 |
| 管理 Prompt 和 Message | 使用 Node 表示执行步骤 |
| 定义和调用 Tool | 使用 Edge 控制执行方向 |
| 使用 Middleware 改变 Agent 上下文 | 处理分支、循环、并行和子图 |
| 使用 `createAgent()` 创建标准 Agent | 保存 Checkpoint |
| 提供 Retriever 等 LLM 应用组件 | 支持暂停、恢复和流式执行 |

## 依赖方向

### LangChain 的 createAgent 使用 LangGraph

`createAgent()` 创建的标准 Agent 底层是一个 LangGraph 图：

```text
Model Node
    │
    ├─ 模型直接回答 ─────────→ END
    │
    └─ 模型请求调用工具
              ↓
          Tools Node
              ↓
          Tool Result
              ↓
          Model Node
```

所以使用 LangChain 的 `createAgent()` 时，虽然没有手写 `StateGraph`，Agent 实际仍由 LangGraph Runtime 执行。

### LangGraph 不依赖 LangChain 才能运行

LangGraph 的 Node 可以是普通 TypeScript 函数，不一定需要模型或 LangChain：

```text
START
  → 读取数据库
  → 校验业务规则
  → 等待人工审批
  → 调用普通 HTTP API
  → END
```

因此依赖关系不是“双向必须依赖”：

```text
LangChain createAgent → 使用 LangGraph Runtime
LangGraph             → 可以独立使用
```

## 为什么需要同时使用

只使用 `createAgent()` 时，适合标准的模型与工具循环：

```text
用户目标 → Agent → Tool → Agent → 最终回答
```

当项目还需要输入检查、角色路由、人工审批、任务中止、恢复和固定业务步骤时，可以在外层增加自定义 LangGraph：

```text
自定义 LangGraph Workflow
  → 输入检查
  → 权限检查
  → 角色路由
  → LangChain createAgent 子图
  → 人工审批
  → 结束
```

此时：

- 外层 LangGraph 控制确定性业务流程。
- 内层 LangChain Agent 动态选择工具。

## 当前项目中的关系

当前 ChatDemo 使用的就是“外层 LangGraph + 内层 LangChain Agent”：

```text
用户请求
   ↓
LangChainProvider
   ↓
外层 LangGraph StateGraph
├─ validate_input
├─ prepare_role_workflow
├─ run_agent
└─ finish
        ↓
LangChain createAgent 子图
Model ↔ Tools
        ↓
LangGraph SQLite Checkpointer
```

对应代码：

| 文件 | 所属层 |
| --- | --- |
| `src/providers/langChainProvider.ts` | LangChain 请求入口 |
| `src/agents/langChainToolAgent.ts` | LangChain `createAgent` |
| `src/agents/agentWorkflowGraph.ts` | LangGraph 外层 Workflow |
| `src/agents/toolMemoryState.ts` | LangGraph State |
| `src/db/sqlite.ts` | LangGraph Checkpointer |

## 最终结论

```text
LangChain = 模型、Prompt、Tool 和 Agent 的高层开发组件

LangGraph = Workflow、状态、分支、持久化和恢复的底层运行时

createAgent = LangChain 提供的高层 API，底层由 LangGraph 驱动

当前项目 = LangGraph 外层 Workflow + LangChain createAgent 子图
```

