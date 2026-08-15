# Multi-Model Chat Demo

这是一个适合学习的 LangChain.js 多模型 AI Assistant 项目，使用
`React + TypeScript + Node.js + Express` 搭建。

它解决了两个很常见的问题：

- 前端页面如何安全地调用大模型，而不把 `API Key` 暴露到浏览器里
- 如何把“只支持一个模型”的 Demo，整理成“可扩展的多模型架构”
- 如何用 LangChain 统一管理模型、消息、工具调用和短期上下文

当前项目已经支持：

- DeepSeek
- OpenAI
- SiliconFlow

并且前端可以直接切换模型，页面也会明确显示“当前实际调用的是哪个模型”。

## 项目适合谁

如果你正在学习下面这些内容，这个项目会比较合适：

- Node.js 后端入门
- TypeScript 基础项目结构
- Express 路由和接口设计
- 环境变量 `.env` 的使用
- 大模型 API 的基本调用方式
- 多模型 provider 抽象思路

## 你能学到什么

做完这个项目，你至少可以理解下面这些点：

- 为什么 `API Key` 不能直接写在前端
- 为什么前端应该请求自己的后端，而不是直接请求模型平台
- 模型切换时，前端和后端分别要做什么
- 如何把不同平台统一成一套调用接口
- 如何用配置表维护模型目录，而不是把逻辑写死在页面里

## 技术栈

- `Node.js`
- `Express`
- `TypeScript`
- `React`
- `LangChain.js`
- `LangGraph`
- `Docker Compose`
- `Chroma`
- `Docling`
- `Zod`
- `dotenv`

## 功能说明

当前已经实现：

- 聊天页面
- 多模型切换
- 服务端代理请求模型平台
- `.env` 环境变量配置
- 仅显示已配置、可实际调用的模型
- 页面顶部显示“当前将调用的模型”
- 聊天消息里显示“本次实际调用的模型”
- SSE 流式输出
- Weather、Calculator、Current Time 自动工具选择
- 基于 `thread_id` 的对话短期记忆
- 对话过长时自动摘要
- 基于消息和工具状态的动态 System Prompt

## 当前支持的模型

目前代码里默认配置了这些模型：

- DeepSeek: `deepseek-v4-flash`
- DeepSeek: `deepseek-v4-pro`
- OpenAI: `gpt-4o-mini`
- SiliconFlow: `Qwen/Qwen2.5-7B-Instruct`

注意：

- 页面不会显示“未配置 key 的模型”
- 只有你在 `.env` 里配置了对应平台的 `API Key`，这个模型才会出现在下拉框里

## 项目结构

```text
.
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── client/
│   └── main.tsx
├── src/
│   ├── agents/
│   │   ├── langChainToolAgent.ts
│   │   ├── toolMemoryState.ts
│   │   └── dynamicMemoryPromptMiddleware.ts
│   ├── providers/
│   │   ├── langChainProvider.ts
│   │   └── openaiCompatibleProvider.ts
│   ├── tools/
│   │   └── langchain/
│   ├── config.ts
│   ├── modelRegistry.ts
│   ├── providerRegistry.ts
│   ├── server.ts
│   └── types.ts
├── .env
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## 各文件是做什么的

### `src/server.ts`

这是服务端入口文件，主要负责：

- 创建 Express 应用
- 提供 `/api/models` 接口，返回模型列表
- 提供 `/api/chat` 接口，接收前端消息并转发给对应模型
- 启动本地服务

你可以把它理解成“总调度中心”。

### `src/config.ts`

这是配置中心，主要负责：

- 读取环境变量
- 维护 provider 的 API 地址和 key
- 维护模型目录 `modelCatalog`

这里是最重要的学习点之一：

- “有哪些模型可选”不是写在前端页面里
- 而是统一放在后端配置表中管理

这样以后扩展会轻松很多。

### `src/providerRegistry.ts`

这是 provider 注册中心，主要负责：

- 创建各个平台对应的 provider 实例
- 把 provider 放进一个统一的注册表里

你可以把它理解成“模型平台清单”。

### `src/providers/langChainProvider.ts`

这是当前实际运行的 LangChain.js AI Assistant Provider。

它的作用是：

- 把 DeepSeek、OpenAI、SiliconFlow 统一适配到 LangChain
- 使用 LangChain Message 表达 Few-shot 和用户消息
- 复用 Agent 与 LangGraph Checkpointer
- 统一提供普通调用和流式调用

`openaiCompatibleProvider.ts` 保留为第三阶段原生 Tool Calling 的学习资料，
默认聊天运行链路不再使用它。

### `src/modelRegistry.ts`

这个文件负责模型相关的辅助逻辑，例如：

- 返回给前端哪些模型可以显示
- 根据 `modelId` 找到对应模型配置

### `src/types.ts`

这里放的是 TypeScript 类型定义，主要作用是：

- 让代码更清晰
- 写接口时更不容易出错
- 方便你理解“前端传什么，后端回什么”

### `public/index.html`

这是页面结构，负责：

- 聊天界面布局
- 模型下拉框
- 输入框和发送按钮

### `public/script.js`

这是前端交互逻辑，负责：

- 页面加载时请求 `/api/models`
- 渲染模型列表
- 提交聊天消息到 `/api/chat`
- 把服务端返回的回复显示到页面上
- 显示“当前调用模型”和“实际调用模型”

### `public/styles.css`

这是页面样式文件，主要负责界面视觉展示。

## 运行教程

### 1. 安装依赖

在项目根目录执行：

```bash
npm install
```

### 2. 配置环境变量

把 `.env.example` 复制一份为 `.env`：

```bash
cp .env.example .env
```

然后编辑 `.env`，按需填入你的 key。

例如你只想用 DeepSeek：

```env
DEEPSEEK_API_KEY=你的_deepseek_api_key
```

例如你还想同时使用 OpenAI：

```env
DEEPSEEK_API_KEY=你的_deepseek_api_key
OPENAI_API_KEY=你的_openai_api_key
```

### 3. 启动全部 Docker 服务

先安装并启动 Docker Desktop，然后执行标准 Compose 命令：

```bash
docker compose up -d
```

该命令会从项目根目录的单个 `compose.yaml` 启动全部 Docker 服务，包括：

- Chroma：`http://127.0.0.1:8000`
- Docling：`http://127.0.0.1:5001`
- Sandbox Orchestrator：`http://127.0.0.1:3010`（仅后端访问）
- Phoenix：`http://127.0.0.1:6006`
- OpenTelemetry Collector：`http://127.0.0.1:4318`

第一次启动需要下载镜像，Docling CPU 镜像体积较大，需要等待下载完成。
Chroma 数据保存在 `data/chroma`，Docling 模型缓存保存在
`data/docling-cache`，重建容器不会清空这些目录。

检查服务状态：

```bash
npm run services:status
```

容器管理统一使用 `docker compose ps`、`docker compose logs -f` 和 `docker compose down`，不需要逐个启动服务。

### 4. 启动桌面应用

```bash
npm run desktop
```

### 5. 只启动 Web 服务

如果暂时不使用 Electron：

```bash
npm start
```

浏览器访问：

```text
http://127.0.0.1:3000
```

### Docker 服务管理

```bash
# 查看 Chroma 和 Docling 日志
npm run services:logs

# 停止容器，但保留 data 目录中的数据
npm run services:down

# 更新两个服务镜像
npm run services:pull
```

## 开发模式

如果你想边改边看效果，可以开两个终端：

第一个终端：

```bash
npm run dev
```

作用：

- 持续监听 TypeScript 文件变化
- 自动重新编译到 `dist/`

第二个终端：

```bash
npm run dev:serve
```

作用：

- 监听 `dist/server.js`
- 编译后自动重启 Node 服务

## 环境变量说明

项目中用到的主要环境变量如下：

### `DEEPSEEK_API_KEY`

DeepSeek 的 API Key。

如果你配置了它，前端会显示 DeepSeek 对应模型。

### `OPENAI_API_KEY`

OpenAI 的 API Key。

如果你配置了它，前端会显示 OpenAI 对应模型。

### `SILICONFLOW_API_KEY`

SiliconFlow 的 API Key。

如果你配置了它，前端会显示 SiliconFlow 对应模型。

### `PORT`

本地服务端口，默认是：

```env
PORT=3000
```

### `HOST`

服务监听地址，默认是：

```env
HOST=127.0.0.1
```

### `DEEPSEEK_API_URL`

DeepSeek 接口地址，一般不需要改。

### `OPENAI_API_URL`

OpenAI 接口地址，一般不需要改。

### `SILICONFLOW_API_URL`

SiliconFlow 接口地址，一般不需要改。

## 调用流程讲解

这是这个项目最值得学习的一部分。

### 第 1 步：前端请求模型列表

页面加载时，前端会请求：

```text
GET /api/models
```

服务端会根据当前 `.env` 中配置了哪些 key，返回“可用模型列表”。

### 第 2 步：用户选择模型并输入消息

用户在页面里：

- 选择一个模型
- 输入一段内容
- 点击发送

前端会把数据提交到：

```text
POST /api/chat
```

请求体大概长这样：

```json
{
  "modelId": "deepseek-v4-flash",
  "message": "你好，介绍一下你自己"
}
```

### 第 3 步：服务端查找模型配置

后端收到请求后会：

- 根据 `modelId` 去 `modelCatalog` 查找
- 确定它属于哪个 provider
- 找到对应 provider 实例

### 第 4 步：服务端请求上游模型平台

然后服务端会把请求转发到真正的模型平台，比如 DeepSeek：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    {
      "role": "system",
      "content": "你是一个友好的 AI 助手..."
    },
    {
      "role": "user",
      "content": "你好，介绍一下你自己"
    }
  ]
}
```

### 第 5 步：服务端返回结果给前端

服务端拿到模型回复后，再把结果返回给浏览器。

同时还会附带本次调用的元信息，比如：

- `provider`
- `modelId`
- `modelLabel`

所以你在页面上可以明确知道，这一轮消息到底调用了哪个模型。

## 为什么不能把 API Key 写在前端

因为前端代码会暴露给浏览器，用户打开开发者工具就能看到。

如果你把 key 写在前端：

- 别人可以直接复制你的 key
- 可能导致额度消耗
- 可能造成费用风险

所以正确做法是：

- 前端只请求你自己的后端
- 后端再去请求模型平台
- `API Key` 只保存在服务端 `.env`

## 如何新增一个模型

如果你只是想在现有 provider 下增加模型，最简单。

直接修改 [src/config.ts](/home/lsq/project/stduy/chatDemo/src/config.ts) 里的 `modelCatalog`，新增一项：

```ts
{
  id: "你的模型名",
  label: "页面显示名称",
  provider: "deepseek",
  description: "模型说明",
  enabled: true
}
```

然后重新编译：

```bash
npm run build
```

## 如何新增一个 provider

如果你要接一个全新的模型平台，一般分 3 步：

### 第 1 步：在 `src/config.ts` 增加环境变量配置

你需要给这个 provider 增加：

- `API_KEY`
- `API_URL`

### 第 2 步：实现 provider

如果它兼容 OpenAI 风格接口，可以继续复用：

[src/providers/openaiCompatibleProvider.ts](/home/lsq/project/stduy/chatDemo/src/providers/openaiCompatibleProvider.ts)

如果它不兼容，就新建一个自己的 provider 文件。

### 第 3 步：在 `src/providerRegistry.ts` 注册

把新的 provider 实例加入注册表，后端才能找到它。

## 常见问题

### 1. 页面里看不到模型

常见原因：

- 还没配置对应平台的 `API Key`
- 改了 `.env` 以后没有重启服务
- 没有重新执行 `npm run build`

### 2. 页面里模型名称不对

模型名称来自后端配置表，不是自动从平台拉取的。

也就是说，页面显示什么名字，取决于：

[src/config.ts](/home/lsq/project/stduy/chatDemo/src/config.ts)

里的 `modelCatalog` 写了什么。

### 3. 我怎么确认当前真的在用某个模型

这个项目现在已经做了两层提示：

- 顶部会显示：`当前将调用：provider / modelId`
- 回复消息里会显示：`实际调用模型：provider / modelId`

### 4. 为什么点击终端里的网址会在 VS Code 内部打开

这通常是 VS Code 内置的 `Simple Browser` 行为，不影响项目本身。

如果你想用系统浏览器，可以直接手动打开：

```text
http://127.0.0.1:3000
```

## 后续可以继续练习什么

如果你想继续拿这个项目练手，推荐按下面顺序往下做：

1. 做多轮上下文对话
2. 做流式输出
3. 给每个平台增加独立的系统提示词
4. 做聊天记录持久化
5. 加一个“查看原始请求参数”的调试面板
6. 给模型配置做单独的管理页面

## 总结

这个项目虽然不大，但已经覆盖了一个真实 AI Web Demo 的核心结构：

- 前端界面
- 后端代理
- 环境变量管理
- 多模型切换
- provider 抽象
- TypeScript 分层

如果你能把这个项目读明白、改明白、再自己扩展 1 到 2 个功能，基础就会扎实很多。
# Electron 桌面版

桌面版保留现有 React、LangChain、LangGraph、RAG 和 SQLite 能力，并增加系统原生工作目录选择。

```powershell
npm install
npm run desktop
```

`docker compose up -d` 统一启动 Redis、Chroma、Docling、Sandbox Orchestrator、Phoenix 和 OpenTelemetry Collector。Sandbox Orchestrator 在服务端通过 Docker Socket 创建一次性隔离执行容器，不直接在用户桌面进程中执行命令。项目业务数据继续使用 SQLite，不依赖 PostgreSQL。`npm run desktop` 只构建服务端和 React 并启动 Electron，不再隐式管理 Docker。进入顶部“工作”模式后，点击“选择工作目录”即可使用 Windows 原生文件夹选择器。工作区按用户保存在 Electron 用户数据目录中，重启应用后会自动恢复。

如果国内网络无法从默认源下载 Electron 运行时，可以执行：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
node node_modules\electron\install.js
```

如果看到 `better-sqlite3` 的 `NODE_MODULE_VERSION` 不一致，请不要为 Electron
重编译它。本项目会让 Express/LangGraph 后端使用系统 Node，Electron 只负责桌面窗口和
IPC，从而避免两套 Node ABI 互相覆盖。

安全边界：

- Renderer 保持 `nodeIntegration: false` 和 `contextIsolation: true`。
- React 只能通过 Preload 暴露的受控 IPC 选择、读取或打开工作区。
- Chat 与 Work 使用独立 thread；每个 Work thread 固定绑定一个本机项目目录。
- Coding Agent 可以列出和读取代码文件；创建/修改文件、运行开发命令必须经过人工审批。
- 文件工具只接受工作区相对路径，并禁止访问 `.git`、`.env`、`node_modules` 和工作区外目录。
