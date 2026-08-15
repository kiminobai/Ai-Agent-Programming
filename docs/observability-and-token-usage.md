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

左下角“设置”进入用量页面。已完成的助手回复下方显示该轮模型调用的输入、输出和总 Token。数据根据 `turnId` 从 SQLite 恢复，因此刷新后仍然存在。
