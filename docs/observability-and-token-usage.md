# 可观测性、追踪与 Token 用量

## 一、三层职责

| 层 | 作用 | 是否保存对话正文 |
|---|---|---|
| SQLite 用量账本 | 今日、本月、每轮和按模型统计 Token | 否 |
| OpenTelemetry JavaScript | 为模型、工具和 Agent 阶段生成标准 Trace/Span | 否 |
| Phoenix | 查询调用链、耗时、错误和模型运行趋势 | 默认不采集正文 |

Token 账本是统计的权威来源。Phoenix 或 Collector 停止时，不会影响聊天、工作任务和用量记录。

## 二、追踪内容

项目只导出以下安全属性：

- `userId`、`threadId`、`turnId`、内部任务 ID；
- 模型供应商和模型 ID；
- 输入、输出和总 Token；
- Agent/工具阶段名称、状态和耗时。

项目不导出 System Prompt、消息正文、私有推理、文件正文、工具参数、API Key 和登录 Token。

## 三、数据流

```text
模型 / 工具 / Agent
  -> OpenTelemetry JavaScript
  -> 本机 OTLP Collector（127.0.0.1:4318）
  -> Phoenix（127.0.0.1:6006）

模型调用
  -> model_usage_events（SQLite）
  -> 设置页：今日 / 本月 / 30 天趋势 / 按模型
  -> 对话：当前轮次 Token
```

## 四、启动

```powershell
docker compose up -d
```

全部容器已经集中在根目录的 `compose.yaml` 中。`npm run observability:up` 仅用于单独启动 Phoenix 与 Collector。

打开地址：

- Phoenix：`http://127.0.0.1:6006`

查看状态或日志：

```powershell
npm run observability:status
npm run observability:logs
```

停止观察服务：

```powershell
npm run observability:down
```

Phoenix 数据保存在 `data/observability/phoenix`，不会提交到 Git。项目不依赖 PostgreSQL、ClickHouse 或 MinIO；业务数据继续使用 SQLite。

## 五、前端

左下角“设置”只展示面向用户的 Token 用量：今日、本月、30 天趋势和按模型统计。
设置页不再放 Phoenix 入口或开发者 Trace 状态，避免把内部运维概念暴露给普通用户。

每条**已经完成**的助手回复下方都有折叠的“运行详情”，按 `threadId + turnId`
从 SQLite 读取，因此刷新或重启后仍可恢复。它展示：

- 本轮耗时以及模型、工具调用次数；
- 输入、输出和总 Token；
- 模型、工具、子代理、命令与文件阶段的状态、耗时和重试次数。

“运行详情”不会显示 System Prompt、工具参数、文件正文或模型私有推理。消息仍在生成时只显示
“正在思考”“正在修改文件”“正在运行命令”等用户可理解的状态，完成后才显示持久化详情。

## 六、Phoenix 的定位

Phoenix 是开发者和运维人员使用的自托管 Trace 后端，不是业务数据库，也不是用户设置模块。
需要排查跨节点耗时或错误时，开发者可以直接访问 `http://127.0.0.1:6006`；普通用户只需
查看对话内运行详情和设置页 Token 统计。

业务数据仍在 SQLite，Phoenix 停止或清空不会造成聊天记录、记忆和 Token 账本丢失。

## 七、验证清单

1. 执行 `docker compose ps`，确认 `phoenix` 和 `otel-collector` 正常运行。
2. 完成一轮模型或工具调用，展开对应回复下方的“运行详情”。
3. 刷新页面，确认 Token 和运行事件仍能恢复。
4. 打开 Phoenix，确认能看到 Span，且属性中没有 Prompt、文件正文和密钥。
