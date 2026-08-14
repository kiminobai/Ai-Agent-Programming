# MCP 学习笔记与项目实现

## 1. MCP 是什么

MCP（Model Context Protocol，模型上下文协议）是一套连接 AI 应用与外部能力的标准协议。

没有 MCP 时，每接入一个数据库、编辑器或外部服务，都可能需要编写一套不同的 Tool 适配代码。使用 MCP 后，外部服务可以用统一格式提供：

- `Tools`：可执行操作，例如查询数据库、打开文件或调用 API。
- `Resources`：可读取资源，例如文件、日志和业务数据。
- `Prompts`：服务端提供的可复用提示模板。

MCP 不负责模型推理。模型仍通过 LangChain Agent 决定何时调用 Tool。

## 2. Client、Server 与 Host

```text
用户
  ↓
KimiBai（MCP Host）
  ↓
LangChain Agent（使用 MCP Client）
  ↓
MCP Server
  ├─ Tools
  ├─ Resources
  └─ Prompts
```

当前项目是 MCP Host/Client。数据库、浏览器、编辑器扩展或其他外部程序是 MCP Server。

一次 Tool 调用的流程：

```text
读取 mcp.json
  ↓
连接已启用的 MCP Server
  ↓
发现 Tool 名称、说明和 Schema
  ↓
转换成 LangChain Tool
  ↓
模型按任务选择 Tool
  ↓
副作用 Tool 弹出审批
  ↓
调用 MCP Server
  ↓
Tool 结果返回模型
  ↓
模型生成用户答案
```

## 3. MCP 与现有 Tool 的关系

项目原生 Tool 和 MCP Tool 最终都会进入 `createAgent`：

```text
原生 Tool
  ├─ 工作区文件操作
  ├─ 命令执行
  ├─ RAG
  └─ Memory

MCP Tool
  ├─ 编辑器服务
  ├─ 外部数据库
  ├─ 浏览器
  └─ 第三方 API

          ↓
   LangChain createAgent
```

原生 Tool 适合项目核心能力，MCP Tool 适合可插拔的外部能力。不要为了使用 MCP 而重写已经稳定、安全的工作区 Tool。

## 4. 当前实现

`src/mcp/mcpManager.ts` 负责：

1. 读取项目根目录的 `mcp.json`。
2. 校验 Server 名称、Transport、URL 和工作目录。
3. 通过 `MultiServerMCPClient` 连接多个 Server。
4. 将 MCP Tool 转换成 LangChain Tool。
5. 给 Tool 添加 `mcp__服务器__工具` 前缀。
6. 按 Chat/Work 模式过滤 Tool。
7. 根据 Tool 注解和项目配置决定是否审批。
8. 提供连接状态并在进程退出时关闭连接。

连接失败不会让普通聊天无法启动。失败的 Server 会被隔离，其他原生 Tool 仍可使用。

## 5. Transport

### stdio

应用启动一个本地子进程，通过标准输入输出交换 MCP JSON-RPC 消息。

适合：

- 本地开发工具。
- 可信的编辑器或文件工具。
- 不需要部署远程服务的个人环境。

风险：启用的命令会在本机运行，所以配置默认为关闭，必须由用户明确启用。

### Streamable HTTP

应用通过 HTTP 连接远程 MCP Server。

适合：

- 数据库或公司内部平台。
- 多用户共享服务。
- 需要独立部署和认证的工具。

远程密钥应通过环境变量引用，不得写入 `mcp.json`。

### SSE

SSE 是兼容旧 MCP Server 的 Transport。新服务应优先使用 Streamable HTTP。

## 6. 配置文件

桌面端用户可以在对话输入框左侧点击 `+`，选择“添加 MCP Server”。配置会写入当前对话的独立扩展目录：

```text
Documents/KimiBai/extensions/threads/<threadId>/mcp.json
```

保存后服务只为当前对话重新连接 MCP，并清除旧 Agent 的 Tool Schema 缓存，不需要重启应用。其他对话不会获得这个 MCP Server；删除对话时也会删除对应配置并关闭连接。项目根目录的 `mcp.json` 仍用于开发者预置的应用级能力，同名当前对话配置优先。

最小 stdio 配置：

```json
{
  "servers": {
    "development": {
      "enabled": true,
      "transport": "stdio",
      "command": "node",
      "args": ["path/to/trusted-server.js"],
      "cwd": ".",
      "allowedModes": ["work"],
      "approval": "mutating"
    }
  }
}
```

远程 HTTP 配置：

```json
{
  "servers": {
    "company-tools": {
      "enabled": true,
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MCP_REMOTE_TOKEN}"
      },
      "allowedModes": ["work"],
      "approval": "always"
    }
  }
}
```

配置字段：

| 字段 | 作用 |
| --- | --- |
| `enabled` | 只有 `true` 才连接 |
| `transport` | `stdio`、`http` 或 `sse` |
| `command/args` | stdio Server 启动命令 |
| `url/headers` | HTTP Server 地址和请求头 |
| `allowedModes` | 限制在 Chat 或 Work |
| `approval` | `always`、`mutating` 或 `never` |
| `allowedTools` | 只允许指定 Tool |
| `disabledTools` | 禁用指定 Tool |
| `timeoutMs` | Tool 调用超时 |

## 7. VS Code 与 MCP

VS Code 自己支持 MCP，但通常是作为 MCP Client 使用外部 MCP Server。KimiBai 也是另一个独立 MCP Client，两者不会自动共享内置 Tool。

因此“使用 VS Code 写代码”的正常流程是：

```text
用户在 KimiBai 选择工作目录
  ↓
Agent 使用项目原生安全 Tool 修改文件
  ↓
同一个目录在 VS Code 中打开
  ↓
VS Code 自动看到磁盘文件变化
```

如果需要 Agent 调用 VS Code 特有能力，例如编辑器诊断、选区或扩展 API，必须安装或开发一个可信的 VS Code 扩展/MCP Server，并在 `mcp.json` 中配置它。不能假设任意 VS Code 安装都自动提供远程控制接口。

## 8. 审批策略

| 策略 | 行为 |
| --- | --- |
| `always` | 每次调用都审批，默认且最安全 |
| `mutating` | MCP 标记为只读的 Tool 自动调用，其他 Tool 审批 |
| `never` | 不审批，只适合确定安全的只读 Server |

MCP Server 提供的 `readOnlyHint` 只是声明，不是绝对安全证明。陌生 Server 应继续使用 `always`。

## 9. 安全边界

- 未启用的 Server 不启动。
- Tool 默认只在 Work 模式可用。
- Server 数量最多 10 个，Tool 总数最多 80 个。
- stdio 的 `cwd` 不能越出当前应用项目目录。
- HTTP 只允许 `http` 和 `https`。
- Tool 名称带 Server 前缀，避免重名覆盖。
- 状态接口不返回命令、请求头、环境变量或 Token。
- 外部 Tool 结果属于不可信内容，不能改变系统权限。
- MCP Tool 不能绕过 LangGraph 的 Human-in-the-loop 审批。

## 10. MCP 与 Skill、Subagent

MCP Tool 是能力，`mcp-integration` Skill 是接入和排错方法。

```text
mcp-integration Skill
  ↓ 指导如何安全接入
MCP Tool
  ↓ 执行外部动作
主 Agent / Subagent
  ↓ 决定何时使用
LangGraph
  ↓ 管理状态、审批和恢复
```

当前执行型 Subagent 不会自动继承所有 MCP Tool。后续若要开放，应在具体 Subagent 的 Tool 白名单中逐个授权，不能整体继承。

## 11. 使用和排错

通过对话框安装或修改 MCP 后会自动热加载。开发者直接编辑项目根目录的 `mcp.json` 时，仍建议重启服务，或者再次通过安装接口触发重新加载。

验证配置：

```powershell
npm run mcp:verify
```

查看运行状态：

```text
GET /api/mcp/status
```

常见问题：

- `connected=false`：检查命令、URL、网络和 Server 日志。
- 没有发现 Tool：检查 `allowedTools` 和 `disabledTools`。
- Agent 不调用：确认 Tool 描述与任务相关，并检查 `allowedModes`。
- 没有审批：检查 `approval` 和 Server 的 `readOnlyHint`。
- 修改配置无变化：重启服务，让 Agent 重新获取 Tool Schema。

## 12. 代码位置

| 文件 | 职责 |
| --- | --- |
| `mcp.json` | 当前启用配置 |
| `mcp.example.json` | stdio 与 HTTP 示例 |
| `src/mcp/mcpManager.ts` | MCP 连接、发现、过滤和状态 |
| `src/agents/langChainToolAgent.ts` | 把 MCP Tool 和审批加入 Agent |
| `skills/mcp-integration/SKILL.md` | MCP 专业工作规范 |
| `scripts/verifyMcp.ts` | MCP 配置和连接验证 |
