# LangGraph 完整学习笔记

![LangGraph 完整执行流程图](./langgraph-execution-flow.png)

## 1. LangGraph 是什么

LangGraph 是用于构建**长时间运行、有状态、可恢复**的 Workflow 和 Agent 的底层编排框架。它把业务过程描述为图，并提供持久化、流式输出、人工介入、故障恢复和状态调试等运行时能力。

LangGraph 可以独立使用，也可以和 LangChain 一起使用：

```text
LangChain
├── Model、Prompt、Tool、Retriever 等组件
└── createAgent：快速创建标准 Agent

LangGraph
├── State、Node、Edge：定义执行图
├── Checkpointer、Store：保存状态和记忆
└── Streaming、Interrupt、Command：控制执行过程
```

`createAgent()` 底层也是一个 LangGraph 图。复杂项目可以把 `createAgent` 作为一个子图或 Node，嵌入自定义 LangGraph Workflow。

## 2. Workflow 和 Agent 的区别

### Workflow

Workflow 的路径主要由代码预先确定，适合规则明确、需要稳定控制的任务。

例如：

```text
接收文章 → 提取主题 → 生成摘要 → 人工审查 → 发布
```

### Agent

Agent 的路径由模型根据上下文动态决定。模型可以选择工具、重复调用工具，直到满足停止条件。

例如：

```text
用户目标 → Model
             ├─ 直接回答
             └─ 调用 Tool → Tool Result → 再次 Model
```

### 组合使用

实际项目通常组合二者：

- 外层 Workflow 保证输入检查、权限、审批和结束流程。
- 内层 Agent 自主决定工具调用和解决问题的步骤。
- 确定性步骤交给普通代码，不必全部交给 LLM。

## 3. Graph API 三个基础构件

### State

State 是图中所有 Node 共享的数据快照。Node 读取当前 State，并返回局部更新。

适合放入 State 的数据：

- 后续 Node 仍然需要的数据。
- 重新获取成本较高的数据。
- 中断恢复后必须保留的数据。
- 需要调试或审计的执行结果。

不适合放入 State 的数据：

- 可以随时根据已有数据重新计算的内容。
- 已经格式化好的完整 Prompt。
- 无限制增长且不做裁剪的临时数据。

重要原则：

> State 保存原始数据，Prompt 在 Node 执行时按需组装。

多 Node 同时更新同一个字段时，需要 Reducer 决定覆盖、追加或合并方式。

### Node

Node 是接收 State 并返回 State Update 的函数。Node 可以执行：

- 普通 TypeScript 逻辑。
- LLM 调用。
- 数据库或检索操作。
- 外部 API 和 Tool。
- 用户输入与人工审批。
- 一个完整子图或 Agent。

Node 应尽量只负责一个清晰步骤。Node 越清晰，Checkpoint、重试和调试的边界越明确。

### Edge

Edge 决定下一步执行哪个 Node：

- `addEdge`：固定跳转。
- `addConditionalEdges`：根据 State 动态分支。
- `START`：图入口。
- `END`：图结束。
- 循环边：返回之前的 Node。

## 4. 两种开发 API

### Graph API

Graph API 显式定义 State、Node 和 Edge，适合：

- 分支、循环和并行较多。
- 需要精确查看每个执行步骤。
- 需要定制状态合并和子图。
- 复杂 Agent 或生产工作流。

核心结构：

```ts
const graph = new StateGraph(State)
  .addNode("prepare", prepareNode)
  .addNode("execute", executeNode)
  .addEdge(START, "prepare")
  .addConditionalEdges("prepare", routeNext)
  .addEdge("execute", END)
  .compile({ checkpointer });
```

### Functional API

Functional API 使用 EntryPoint 和 Task 组织普通函数，适合：

- 希望保留过程式代码风格。
- 流程相对线性。
- 不想显式维护大量 Node 和 Edge。
- 仍然需要持久化、暂停恢复和流式能力。

Graph API 和 Functional API 共用 LangGraph Runtime，可以根据任务复杂度选择。

## 5. 控制流能力

### Conditional Edge

Conditional Edge 根据 State 返回路由名称，进入不同分支。适合分类、权限判断、答案验证和错误分流。

### Command

`Command` 可以在一个 Node 中同时：

- 更新 State。
- 指定下一个 Node。
- 恢复 Interrupt。
- 在父图与子图之间导航。

它适合“处理结果后立即决定下一步”的情况。

### Send

`Send` 用于运行时动态创建并行任务，常见于 Orchestrator-Worker：

```text
Planner
  ├─ Send(worker, task A)
  ├─ Send(worker, task B)
  └─ Send(worker, task C)
             ↓
        汇总 Worker 结果
```

### Subgraph

Subgraph 是嵌入父图的另一个图。适合：

- 把复杂能力封装成模块。
- 每个角色或领域拥有独立流程。
- Multi-Agent 中把 Agent 作为子图。
- 复用具有独立 State 的工作流。

子图可以选择：

- 每次调用独立状态。
- 同 Thread 持久状态。
- 完全无状态。

## 6. Persistence 与 Durable Execution

Graph 编译时配置 Checkpointer 后，LangGraph 会按执行步骤保存 Checkpoint，并通过 `thread_id` 区分不同任务。

Checkpoint 支持：

- 多轮对话短期记忆。
- Human-in-the-loop。
- 程序重启后恢复。
- 节点失败后从成功位置继续。
- 查看历史 State。
- Time Travel：从历史 Checkpoint 重放或分叉。
- Fault Tolerance：减少失败后的重复执行。

### Checkpointer 与 Store

两者不要混淆：

| 概念 | 生命周期 | 主要用途 |
| --- | --- | --- |
| Checkpointer | 一个 Thread 内 | 工作流状态、短期记忆、中断恢复 |
| Store | 跨 Thread | 用户偏好、长期记忆、共享业务知识 |

## 7. Streaming

LangGraph 可以流式返回不同类型的信息：

- `messages`：模型 Token。
- `updates`：每个 Node 的 State Update。
- `values`：完整 State 快照。
- `custom`：业务自定义进度。
- `debug`：调试事件。

前端不应该展示模型内部推理。正确做法是：

```text
内部事件 → 转换成业务状态 → 展示“正在检索 / 正在修改文件”
模型 Token → 只展示最终回答内容
```

## 8. Interrupt 与 Human-in-the-loop

`interrupt()` 可以在 Node 中暂停执行，并把 JSON 数据返回给调用方。Graph State 会由 Checkpointer 保存。

恢复时使用：

```ts
new Command({ resume: userDecision })
```

常见场景：

- 写文件前审批。
- 执行命令前审批。
- 发送邮件或支付前确认。
- 让用户补充缺失信息。
- 人工编辑 LLM 草稿后继续。

注意：

- Interrupt 后恢复时，Node 会从开头重新执行。
- Interrupt 之前不要放不可重复的副作用。
- 多个并行 Interrupt 应通过 Interrupt ID 分别恢复。
- 拒绝后必须保证真实 Tool 没有执行。

## 9. Memory

### 短期记忆

短期记忆属于当前 Thread，一般保存在 Checkpointer 中。它包括：

- 当前对话历史。
- 当前任务中间结果。
- 当前工具调用上下文。
- 中断和审批状态。

### 长期记忆

长期记忆跨 Thread 保存，通常使用 Store，并以 `userId` 等 Namespace 隔离：

- 用户偏好。
- 长期事实。
- 跨对话可复用的信息。
- 个性化设置。

上下文过长时可以使用：

- 删除无价值旧消息。
- 滑动窗口。
- 对旧消息做 Summary。
- 把长期事实写入 Store。
- 使用 RAG 按需检索，而不是把所有资料塞进 State。

## 10. 错误处理

设计 Graph 时应区分错误类型：

| 错误类型 | 处理方式 |
| --- | --- |
| 临时网络错误 | Retry Policy、指数退避 |
| LLM 可修复错误 | 把错误写回 State，让 Agent 重试 |
| 用户可修复错误 | Interrupt，等待用户补充 |
| 不可预期程序错误 | 抛出并记录，交给监控排查 |
| 已产生外部副作用 | 使用补偿动作或 Saga |

重试 Node 时要注意幂等性，避免重复写文件、重复支付或重复发送消息。

## 11. 常见 Workflow 模式

### Prompt Chaining

前一步输出作为后一步输入，适合固定分阶段任务。

```text
生成草稿 → 检查格式 → 改写 → 输出
```

### Routing

先分类，再进入不同专用流程。

```text
问题分类
├─ 技术问题 → 技术 Agent
├─ 产品问题 → 产品 Agent
└─ 文档问题 → RAG
```

### Parallelization

多个独立分支并行执行，再汇总结果：

- Sectioning：拆成不同子任务。
- Voting：多个模型对同一问题给出结果后投票。

### Orchestrator-Worker

Orchestrator 动态拆分任务，通过 `Send` 创建 Worker，最后综合结果。适合任务数量无法预先确定的场景。

### Evaluator-Optimizer

Generator 生成结果，Evaluator 评价；不合格则携带反馈循环改进。

```text
Generator → Evaluator
    ↑          │
    └─反馈─────┘
```

## 12. Agent 与 Multi-Agent 模式

### 单 Agent

一个 Agent 配合合适的 Prompt、Tools 和动态上下文。大多数项目应先从单 Agent 开始。

### Subagents

主 Agent 把专门任务作为 Tool 交给子 Agent，最终控制权仍在主 Agent。

### Handoffs

一个 Agent 把对话控制权交给另一个 Agent，适合不同角色直接与用户交互。

### Router

Router 对输入分类，把任务发送给一个或多个专用 Agent，再汇总答案。

### Custom Workflow

使用 LangGraph 自定义确定性流程，并把 Agent、Router、Subagent 或 RAG 作为 Node 组合进去。

Multi-Agent 不是越多越好。只有在工具太多、上下文隔离、并行任务或团队独立维护确实需要时再使用。

## 13. Thinking in LangGraph

官方推荐的设计顺序：

1. 先描述要自动化的真实业务流程。
2. 把流程拆成离散步骤。
3. 判断每一步属于 LLM、Data、Action 还是 User Input。
4. 设计 State，只保存跨步骤真正需要的原始数据。
5. 为每一步创建单一职责 Node。
6. 用固定 Edge、条件 Edge、Command 和 Send 连接流程。
7. 为网络错误配置 Retry。
8. 为高风险副作用加入 Interrupt。
9. 配置 Checkpointer。
10. 加入 Streaming、Tracing、测试与部署。

## 14. 测试与可观测性

建议分层测试：

- Node 单元测试。
- 路由条件测试。
- State Reducer 测试。
- Interrupt 批准和拒绝测试。
- Checkpoint 恢复测试。
- Tool 幂等性和权限测试。
- Graph 端到端测试。

生产环境还需要记录：

- 当前 Thread 和 Run。
- 每个 Node 的输入输出。
- Tool 调用与耗时。
- Token、模型和错误。
- Interrupt、审批人和审批结果。

LangSmith 可用于 Trace、调试和评估，但 LangGraph 本身并不强制绑定 LangSmith。

## 15. 当前 ChatDemo 项目映射

当前项目属于“自定义 Workflow 包含一个 Agent 子图”：

```text
React / Electron
  → Express + SSE
  → 外层 StateGraph
      validate_input
      → prepare_role_workflow
      → run_agent(createAgent 子图)
      → finish
  → SQLite Checkpointer
```

| 项目文件 | LangGraph 职责 |
| --- | --- |
| `src/agents/agentWorkflowGraph.ts` | 外层 StateGraph、Node、Edge |
| `src/agents/langChainToolAgent.ts` | createAgent 子图、Streaming、Interrupt 恢复 |
| `src/agents/toolMemoryState.ts` | State |
| `src/workflows-agents/` | 角色规则和 Workflow 配置 |
| `src/tools/langchain/` | Tools |
| `src/db/sqlite.ts` | SQLite Checkpointer |
| `src/server.ts` | Agent Harness、SSE、停止信号 |
| `client/main.tsx` | UI、进度、审批 |

当前角色共享同一套外层图结构，但拥有不同 Prompt、Workflow ID 和执行规则。未来可以把不同角色扩展成真正不同的 Subgraph。

## 16. 学习顺序

1. State、Node、Edge。
2. Graph API 与 Conditional Edge。
3. Command、Send 和循环。
4. Checkpointer、Thread 和持久化。
5. Streaming。
6. Interrupt 与 HITL。
7. Subgraph。
8. Workflow 常见模式。
9. createAgent 与 Agent Loop。
10. Multi-Agent。
11. Durable Execution、Time Travel 和部署。

## 官方资料

- [LangGraph Overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)
- [Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
- [Workflows and Agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)
- [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)
