# Subagents 子代理学习笔记

![Subagents 执行流程](./subagents-flow.png)

## 1. Subagent 是什么

Subagent 是由主管 Agent 按需调用的专职 Agent。它拥有独立的 System Prompt、上下文窗口和工具权限，只负责一个明确的专业任务，然后把结果返回主管。

```text
用户只与主管 Agent 对话
        ↓
主管判断是否需要专业协作
        ├─ 简单任务：主管直接处理
        └─ 复杂任务：委派一个或多个 Subagent
                           ↓
                      返回专业结果
                           ↓
                   主管汇总并回答用户
```

Subagent 的结果是主管的内部工作资料，不是最终回答。前端可以展示“哪个子代理正在处理什么”，但不能展示隐藏 Prompt、内部推理或未经主管验证的草稿。

## 2. 使用边界

适合使用 Subagent：

- 一个任务需要不同专业视角，例如架构、实现和测试。
- 主 Agent 的工具过多，需要把工具按领域隔离。
- 子任务需要独立上下文，避免污染主管对话。
- 多个专业分析彼此独立，可以并行完成。
- 不同团队需要独立维护自己的 Prompt 和工具。

不适合使用 Subagent：

- 简单问答、翻译或一次工具调用。
- 只是把一个很小的问题人为拆成多层。
- 子任务高度依赖完整对话，复制上下文的成本比直接处理更高。
- 只是为了让系统看起来更“智能”。

判断原则：

> 子代理带来的专业性、上下文隔离或并行收益，必须大于额外模型调用、Token 和调度成本。

## 3. Custom Subagents

当前项目的每个角色都是主管，并拥有自己的一组 Custom Subagents。例如 Python 工程师角色包含：

```text
Python 工程师主管
├─ Python 架构子代理
├─ Python 实现子代理
└─ Python 测试子代理
```

每个 Custom Subagent 由以下配置组成：

| 配置 | 作用 |
| --- | --- |
| `id` | 稳定标识，用于 Tool 名称和运行记录 |
| `label` | 前端展示名称 |
| `description` | 告诉主管何时应该调用 |
| `systemPrompt` | 子代理的专业身份和输出要求 |
| `contextPolicy` | 控制接收哪些上下文以及最大长度 |
| `toolPolicy` | 显式声明允许调用的 Tool |

角色定义位于 `src/workflows-agents/`，公共运行层位于 `src/agents/roleSubAgentTools.ts`。新增角色子代理时修改定义，不需要复制整套 Agent 运行代码。

## 4. Context Management

子代理不应该继承主管的完整对话历史。当前项目只传入：

```text
主管角色（可配置）
委派任务（必须）
完成任务必需的上下文（可选）
期望产出（可配置）
```

`contextPolicy.maxContextChars` 会截断过长上下文，避免主管误把整个对话、整份文档或无关工具历史复制进去。

正确做法：

- 传递事实、约束、接口和需要分析的片段。
- 用 RAG 或只读 Tool 按需获取资料。
- 让主管保留完整用户对话和最终决策。
- 子代理返回结论、风险和建议，不返回冗长思考过程。

错误做法：

- 把所有消息原样传入每个子代理。
- 把长期记忆、上传文档全文和工具历史全部塞入 Prompt。
- 让不同子代理共享可无限增长的消息列表。

## 5. Tool 权限

Subagent 使用显式白名单，而不是继承主管全部工具。

当前默认只读工具：

- `calculator`
- `current_time`
- `get_weather`
- `retrieve_knowledge_base`
- `retrieve_uploaded_document_chunks`
- `recall_preference`
- `list_workspace_files`
- `read_workspace_file`

无论角色配置如何，运行层都会阻止以下副作用工具：

- `write_workspace_file`
- `run_workspace_command`
- `remember_preference`

原因是写文件、运行命令和写长期记忆必须由主管统一判断，并经过项目现有的 Human-in-the-loop 审批。子代理不能绕过主管直接改变外部状态。

## 6. Supervisor 与 Tool Calling

每个 Subagent 被包装成主管可以调用的内部 Tool：

```text
consult_python_architect
consult_python_implementer
consult_python_test_engineer
```

主管根据 Tool 的名称、描述和 Schema 决定是否调用。Schema 只允许传入：

- `task`：清晰、独立的专业任务。
- `context`：完成任务必需的最小背景。
- `expectedOutput`：主管需要的结果形式。

子代理可继续调用自己白名单中的只读 Tool，但不能调用另一个子代理，也不能直接操作工作区副作用。

## 7. 一级与二级任务目录

前端采用两级目录：

```text
一级：当前角色主管任务
├─ 二级：架构子代理任务
├─ 二级：实现子代理任务
└─ 二级：测试子代理任务
```

一级目录显示主管、子任务数量和整体状态；二级目录显示子代理名称、任务摘要、允许工具、运行状态、耗时和是否复用 Durable 结果。

目录支持展开和收起。只有本轮实际调用了 Subagent 才会显示，不会为每条普通回答固定展示空目录。

## 8. 持久化、耐久执行与隐私

`subagent_runs` 表保存任务树元数据：

- 父子 Run ID。
- Thread、Turn 和角色。
- Agent 名称与任务摘要。
- 工具白名单。
- 运行状态、开始时间、完成时间和错误。

它不保存并展示子代理的私有分析内容。刷新页面后，前端通过 `/api/subagents/runs` 恢复目录。

子代理模型调用还经过 `executeDurableTask`：

- 同一工具调用恢复时复用成功结果。
- 避免因重试重复消耗模型 Token。
- 并发重复调用只能有一个领取执行权。

## 9. Subagents 与其他概念的区别

| 概念 | 核心作用 |
| --- | --- |
| 普通 Tool | 执行确定性能力，例如计算、检索或文件操作 |
| Subagent | 使用独立 Prompt 和上下文完成专业推理 |
| `parallel_read` | 单 Agent 的只读任务并行，不是 Multi-Agent |
| Workflow | 用固定或条件 Edge 控制流程 |
| Handoff | 把对话控制权交给另一个 Agent |
| Supervisor | 用户仍面对主管，子代理只在内部协作 |

当前项目使用 Supervisor 模式，不使用 Handoff。最终用户始终与所选角色主管对话。

## 10. 当前项目文件映射

| 文件 | 职责 |
| --- | --- |
| `src/workflows-agents/types.ts` | Custom Subagent、Context 和 Tool Policy 类型 |
| `src/workflows-agents/*.ts` | 各角色的专职子代理定义 |
| `src/agents/roleSubAgentTools.ts` | 创建子代理、限制上下文、过滤工具、调用模型 |
| `src/agents/subAgentRunRepository.ts` | 持久化一级/二级任务树 |
| `src/agents/durableTaskExecution.ts` | 子代理调用幂等与结果复用 |
| `src/agents/langChainToolAgent.ts` | 主管 Agent、事件过滤与进度状态 |
| `client/main.tsx` | 两级目录交互 |
| `public/styles.css` | 任务树视觉样式 |

