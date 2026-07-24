# AI Agent 核心概念学习笔记

## 1. 学习路线与整体关系

本笔记按照《AI Agent 学习手册》的主线组织：

```text
1. LLM
   ↓
2. Prompt Engineering
   ↓
3. Tool Calling
   ↓
4. LangChain.js
   ↓
5. Memory
   ↓
6. RAG
   ↓
7. LangGraph.js
   ↓
8. Multi-Agent
```

它们最终组合成完整的 Agent 应用：

```text
LLM：理解问题并生成决策
Prompt：约束角色和行为
Tools：连接真实世界并执行动作
LangChain：快速组装模型、Prompt、Tools 和 Agent Loop
Memory：保存当前线程或跨会话信息
RAG：从外部知识库检索事实
LangGraph：编排复杂、有状态、可恢复的工作流
Multi-Agent：让多个专业 Agent 分工协作
```

---

## 2. LLM 是什么

LLM 是 Large Language Model，即大语言模型。它通过大量文本和代码训练，根据已经出现的 Token 预测接下来最可能出现的 Token。

```text
输入：Prompt + 历史消息 + Tool 结果
                 ↓
                LLM
                 ↓
输出：文本回答或 Tool Call
```

LLM 是 Agent 的理解和决策核心，但它不等于完整 Agent：

```text
LLM + Prompt + Tools + Memory + Workflow = Agent 系统
```

### LLM 能做什么

- 理解自然语言需求。
- 生成、解释和审查代码。
- 提取、分类、总结和改写文本。
- 根据 Tool Schema 决定是否调用工具。
- 根据工具结果继续分析并组织最终答案。
- 按指定 JSON Schema 生成结构化输出。

### LLM 不能可靠完成什么

- 自动知道训练截止日期之后发生的事情。
- 永久记住不同 API 请求中的信息。
- 保证每个事实和计算都正确。
- 自己访问互联网、数据库或本地文件。
- 自己真正执行 Tool Call。
- 代替代码中的权限、参数和业务规则校验。

LLM 可能生成听起来合理但实际错误的内容，这种现象通常称为 Hallucination，即幻觉。因此，实时天气、当前时间、精确计算和业务数据应通过真实 Tool 获取。

### Token

Token 是模型处理文本的基本单位，不一定等于一个汉字或一个英文单词。

一次请求消耗的 Token 通常包括：

```text
输入 Token
├── System Prompt
├── Few-shot Examples
├── 历史消息
├── 用户当前问题
├── Tool Schemas
└── Tool Results

输出 Token
└── 模型生成的回答或 Tool Calls
```

Prompt、Few-shot 和历史消息越长，请求成本和响应时间通常越高。

### Context Window

Context Window 是模型单次调用能够处理的最大上下文范围。它包含输入内容以及模型需要生成的输出。

上下文窗口不是永久 Memory。即使模型支持很长的上下文，如果应用下一次请求没有重新传入历史信息，模型仍然不知道之前发生过什么。

长对话不能只依赖无限追加消息，应配合：

- 删除无关历史。
- 对旧消息生成摘要。
- 使用 Memory 保存稳定信息。
- 使用 RAG 检索相关片段。
- 只把当前任务需要的信息传给模型。

### 常见模型参数

| 参数 | 作用 |
| --- | --- |
| `model` | 指定使用哪个模型 |
| `temperature` | 调整输出随机性；越低通常越稳定 |
| `max_tokens` | 限制最大输出长度 |
| `stream` | 是否以增量方式返回内容 |
| `tools` | 提供给模型选择的 Tool Schemas |
| `tool_choice` | 控制模型自动选择、强制调用或禁止工具 |
| `response_format` | 约束结构化输出格式 |

不同 Provider 和模型支持的参数并不完全相同，使用前应查看对应官方文档。推理类模型也可能拥有独立的推理强度或思考内容参数。

### 普通对话模型与推理模型

普通对话模型通常响应更快，适合：

- 日常问答。
- 文本改写和总结。
- 简单信息提取。
- 常规 Tool Calling。

推理模型会投入更多计算处理复杂问题，适合：

- 复杂代码和系统设计。
- 多条件规划。
- 数学与逻辑问题。
- 需要多步判断的 Agent 任务。

推理模型并不代表结果一定正确。重要结果仍然需要工具、测试或人工验证，并且不应要求模型公开完整的隐藏思维链。

### Streaming

非流式请求需要等待完整回答生成后一次性返回：

```text
请求 → 等待完整生成 → 完整答案
```

Streaming 会将模型生成的内容分片发送：

```text
请求 → 片段 1 → 片段 2 → 片段 3 → 完成
```

Streaming 主要改善用户感受到的响应速度，并不会自动减少 Token，也不会改变最终模型能力。

Tool Calling 的流式响应需要额外处理，因为工具名称和 JSON 参数可能分散在多个增量片段中。应用应先正确拼接完整 Tool Call，再执行工具。

### Model、Provider 与 SDK

这三个概念容易混淆：

| 概念 | 含义 | 当前项目示例 |
| --- | --- | --- |
| Model | 真正处理输入并生成结果的模型 | `deepseek-chat` |
| Provider | 提供模型 API 服务的厂商 | DeepSeek |
| SDK | 应用调用 Provider API 的代码库 | OpenAI 兼容 JavaScript SDK |

DeepSeek 提供 OpenAI 兼容 API，因此当前项目可以使用 `openai` npm SDK，并通过 DeepSeek 的 `baseURL` 和 API Key 访问 DeepSeek 模型。这不代表项目使用的是 OpenAI 模型。

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const response = await client.chat.completions.create({
  model: "deepseek-chat",
  messages: [
    { role: "system", content: "你是一位严谨的编程助手。" },
    { role: "user", content: "解释 TypeScript 泛型。" },
  ],
});
```

### LLM 在 Tool Calling 中的职责

LLM 负责：

- 理解用户意图。
- 阅读 Tool Schema。
- 选择适合的工具。
- 生成工具名称和参数。
- 阅读工具执行结果。
- 组织最终自然语言答案。

应用程序负责：

- 注册可用工具。
- 校验工具名称和参数。
- 执行真实函数或外部 API。
- 控制权限、超时和重试。
- 把结果返回给 LLM。
- 防止无限工具循环。

```text
LLM 是决策者，不是执行者。
Tool Executor 才是真正的执行者。
```

### 当前项目中的 LLM

当前 ChatDemo 的主要模型来源是 DeepSeek：

```text
React 前端
  ↓ 用户消息
Node.js 后端
  ↓ System Prompt + Few-shot + Tools
OpenAI Compatible Provider
  ↓ DeepSeek API
DeepSeek LLM
  ↓ 文本增量或 Tool Calls
后端执行工具并继续对话
  ↓
SSE Streaming 返回前端
```

`openaiCompatibleProvider.ts` 承担 Provider 适配、消息构造、Streaming 和 Tool Calling 循环；DeepSeek 模型承担语言理解、工具选择和答案生成。

---

## 3. Prompt Engineering

Prompt 是开发者传给 LLM 的指令和上下文，用来说明模型应该扮演什么角色、完成什么任务、遵守什么约束，以及采用什么输出格式。

LLM 不会自动知道当前项目的业务目标。Prompt 相当于给模型提供本次工作的说明书：

```text
Prompt
├── 你是谁：角色
├── 要做什么：任务目标
├── 已知什么：背景与上下文
├── 不能做什么：边界与约束
├── 如何完成：策略与步骤
└── 如何回答：输出格式
```

### 常见消息角色

| 消息角色 | 作用 |
| --- | --- |
| System Prompt | 定义角色、长期规则、行为边界和回答风格 |
| User Prompt | 用户当前提出的问题或任务 |
| Assistant Message | 模型以前的回答，也可作为 Few-shot 示例 |
| Tool Message | 工具执行结果，供模型继续判断和回答 |

通常优先级是 System 指令高于普通 User 请求。应用不应该让用户输入直接覆盖安全规则、工具权限或开发者约束。

### 零样本提示 Zero-shot Prompt

零样本提示只描述任务和要求，不提供参考答案。

```text
你是一位高级 Python 工程师。
请分析下面代码的性能问题，并提供可运行的优化版本。
回答中应包含复杂度、异常处理和测试建议。
```

适合以下场景：

- 模型已经熟悉该类型任务。
- 任务要求简单清晰。
- 不需要严格模仿固定输出风格。
- 希望减少 Prompt Token。

当前项目中的 `pythonEngineerZeroShotPrompt`、`productManagerZeroShotPrompt` 等变量，就是各角色独立的零样本提示。

### 少样本提示 Few-shot Prompt

少样本提示在任务指令之外，再提供一组“用户输入 → 理想回答”的示例。

```ts
export interface FewShotExample {
  user: string;
  assistant: string;
}

const examples: FewShotExample[] = [
  {
    user: "如何处理 10GB 日志文件？",
    assistant: "使用逐行读取或生成器，避免一次性加载到内存……",
  },
];
```

Few-shot 的作用不是给模型保存永久记忆，而是通过示例向模型展示：

- 应采用什么思考方式。
- 回答需要多详细。
- 应使用什么结构和语气。
- 什么样的答案才符合业务标准。
- 遇到相似问题时如何处理。

每个角色应该有不同的 Few-shot Examples。Python 工程师、产品经理和代码审查专家的目标不同，因此不能共用完全相同的示例。

示例并不是越多越好。应优先选择高质量、有代表性、与当前问题相关的示例，否则会增加 Token 成本，甚至把模型引向错误模式。

### Structured Reasoning

Structured Reasoning 要求模型先明确目标和约束、拆解问题、比较方案，再输出结论。它强调可验证的分析结构，而不是要求模型公开完整内部思维链。

当前项目的 `structuredReasoningInstructions` 主要要求：

- 明确目标、约束和已知信息。
- 将复杂问题拆成关键步骤。
- 比较多种方案的优缺点和风险。
- 信息不足时说明假设。
- 补充边界条件、测试点或验证方式。
- 最终输出结论和简要依据，不展示完整内部思维链。

### ReAct

ReAct 可以理解为 Reasoning + Acting，即模型根据当前信息决定下一步行动，观察行动结果后再继续判断。

带有真实 Tools 时：

```text
理解问题
  ↓
决定调用天气工具
  ↓
获得真实天气结果
  ↓
判断是否还需要其他工具
  ↓
生成最终回答
```

没有外部工具时，“行动”也可以是检查假设、比较方案、验证边界或构造示例。但 Prompt 中不应强迫模型输出隐藏的完整思维过程，只需输出结论、关键依据、工具结果和必要步骤。

### 当前项目如何组合 Prompt

当前项目使用 `PromptRole` 描述一个可选角色：

```ts
export interface PromptRole {
  id: string;
  label: string;
  summary: string;
  systemPrompt: string;
  fewShotExamples?: FewShotExample[];
}
```

每个角色文件采用下面的组合方式：

```ts
export const pythonEngineerRole: PromptRole = {
  id: "python-engineer",
  label: "Python 工程师",
  summary: "处理 Python 开发、性能和工程实践问题",
  systemPrompt: withStructuredReasoningAndReAct(
    pythonEngineerZeroShotPrompt,
  ),
  fewShotExamples: pythonEngineerFewShotExamples,
};
```

组合后的消息大致是：

```text
System：角色零样本提示 + Structured Reasoning + ReAct
User：Few-shot 示例问题 1
Assistant：Few-shot 示例答案 1
User：Few-shot 示例问题 2
Assistant：Few-shot 示例答案 2
User：用户本次真实问题
```

### 编写 Prompt 的实用原则

- 目标要具体，不要只写“你是一个有用的助手”。
- 写清输入、输出、约束和成功标准。
- 稳定规则放在 System Prompt，动态数据放在 User 或 Tool Message。
- 用 Few-shot 展示复杂要求，不要只靠抽象描述。
- 避免互相冲突或重复的指令。
- Prompt 不能代替代码校验、权限控制和业务规则。
- 修改 Prompt 后应使用固定测试问题比较结果，而不是只凭感觉判断。

---

## 4. Tool Calling

Tool 是由应用程序提供给模型的外部能力。模型可以判断何时使用 Tool 并生成调用参数，但真正的代码由应用服务器执行。

LLM 本身只负责生成 Tool Call：

```text
LLM 输出：
{
  "name": "get_weather",
  "arguments": {
    "location": "中国北京",
    "unit": "celsius"
  }
}
```

应用收到 Tool Call 后，验证参数、执行天气 API，再把结果作为 Tool Message 交回模型。

### 一个 Tool 的组成

```text
Tool
├── Name：稳定、唯一的工具名称
├── Description：什么时候应该或不应该调用
├── Parameters：JSON Schema 参数定义
├── Executor：真正执行任务的代码
└── Result：返回给模型的结构化结果
```

其中 Schema 是给 LLM 看的能力说明，Executor 是应用真正运行的代码。只有 Schema 而没有 Executor，模型虽然能生成调用请求，但系统无法完成实际操作。

### Tool Schema

当前项目的天气工具 Schema：

```ts
export const getWeatherTool = {
  type: "function",
  name: "get_weather",
  description:
    "查询指定地点的当前天气。仅用于实时天气，不用于天气预报或历史天气。",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "要查询的城市和地区。",
      },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "温度单位。",
      },
    },
    required: ["location", "unit"],
    additionalProperties: false,
  },
} as const;
```

高质量 Schema 应做到：

- `name` 简短、稳定，并使用模型兼容的字符。
- `description` 明确调用时机和能力边界。
- 每个参数都有清晰描述。
- 枚举值使用 `enum` 限制。
- 必填参数放进 `required`。
- 使用 `additionalProperties: false` 拒绝未知字段。
- 即使启用 `strict`，Executor 仍然必须在运行时校验参数。

### Tool Executor

Executor 接收模型生成的参数并执行真实逻辑。

```ts
export async function executeTool(
  name: SupportedToolName,
  argumentsValue: unknown,
): Promise<unknown> {
  switch (name) {
    case "get_weather":
      return executeGetWeather(argumentsValue);
    case "calculator":
      return executeCalculator(argumentsValue);
    case "current_time":
      return executeCurrentTime(argumentsValue);
  }
}
```

当前项目已经实现三个真实工具：

| Tool | 作用 | Executor |
| --- | --- | --- |
| `get_weather` | 查询指定城市的实时天气 | 调用 Open-Meteo API |
| `calculator` | 执行加、减、乘、除 | 在本地进行可靠计算 |
| `current_time` | 查询指定 IANA 时区的当前时间 | 使用系统时间与 `Intl` |

### 为什么计算也要使用 Tool

LLM 的核心能力是预测文本，不是可靠执行数学运算。简单算术有时可以答对，但复杂数字、精度和边界条件容易出错。

Calculator Tool 将“理解用户想算什么”交给 LLM，把“准确执行运算”交给确定性代码。这体现了 Agent 的重要分工：

```text
LLM：理解、规划、选择
Tool：查询、计算、修改、执行
```

### Tool Calling 完整流程

```text
1. 应用把用户消息和 toolSchemas 发给 DeepSeek
2. DeepSeek 判断是否需要工具
3. DeepSeek 返回一个或多个 Tool Calls
4. 应用校验工具名称和参数
5. toolExecutor 调用对应 Executor
6. 应用把执行结果作为 Tool Message 发回 DeepSeek
7. DeepSeek 根据真实结果生成答案
8. 如果仍需工具，则继续循环
```

`tool_choice: "auto"` 表示模型可以自动选择：

- 不调用任何工具，直接回答。
- 调用一个工具。
- 调用多个工具。
- 根据第一轮结果继续调用其他工具。

### Multiple Tools

Multiple Tools 有两层含义：

- 给模型注册多个可选工具，例如天气、计算器和时间。
- 模型在一次回答中生成多个 Tool Calls，例如同时查询上海时间并计算 `81 / 9`。

互不依赖的 Tool Calls 可以并行执行；有依赖关系的调用则应串行执行。例如必须先查询城市，再根据城市结果查询天气时，不能盲目并行。

### Tool 安全原则

- 不信任模型生成的参数，必须再次校验。
- 工具名称只能来自允许列表。
- 设置超时、重试和错误处理。
- 不把 API Key 或内部异常堆栈返回给模型。
- 查询类工具和写入类工具应使用不同权限。
- 删除文件、付款、发邮件等高风险操作需要人工审批。
- 记录调用参数、结果、耗时和失败原因。
- 对 Agent Loop 设置最大轮数，避免无限调用。

### Prompt 与 Tools 的关系

Prompt 告诉模型“应该如何做”，Tool 让模型“真的可以做”。

```text
Prompt：
需要实时信息时，请使用可用工具，不要猜测。

Tool Schema：
系统当前提供 get_weather、calculator、current_time。

Executor：
服务器执行真实查询或计算。
```

Prompt 不能凭空创造工具。即使 Prompt 写着“你可以查询天气”，如果请求中没有提供 `get_weather` Schema 和 Executor，模型仍然无法获得真实天气。

---

## 5. LangChain.js 是什么

LangChain 是一个用于开发 LLM 应用和 Agent 的高层开源框架。

不同模型厂商的请求格式、Tool Calling 格式和响应结构可能不同。LangChain 提供统一接口，让开发者可以用相似的方式连接模型、Prompt、工具、结构化输出和 Agent。

### LangChain 主要解决的问题

- 统一连接不同的 LLM Provider。
- 定义和注册 Tools。
- 管理 Prompt 与消息。
- 使用 `createAgent` 快速创建 Tool Calling Agent。
- 使用 Middleware 加入日志、重试、摘要、人工审批和安全检查。
- 支持结构化输出、流式输出和 Agent 调用。

### 简化示例

```ts
import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const calculator = tool(
  async ({ a, b }) => String(a + b),
  {
    name: "calculator",
    description: "计算两个数字的和",
    schema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
);

// DeepSeek 提供 OpenAI 兼容接口，可通过自定义 baseURL 接入。
const model = new ChatOpenAI({
  model: "deepseek-chat",
  apiKey: process.env.DEEPSEEK_API_KEY,
  configuration: {
    baseURL: "https://api.deepseek.com",
  },
});

const agent = createAgent({
  model,
  tools: [calculator],
  systemPrompt: "你是一位严谨的计算助手。",
});

const result = await agent.invoke({
  messages: [
    { role: "user", content: "计算 25 + 17" },
  ],
});
```

`createAgent` 会自动执行类似下面的循环：

```text
用户问题
  ↓
调用 LLM
  ↓
LLM 是否请求工具？
  ├── 是 → 执行工具 → 把结果交回 LLM → 再次判断
  └── 否 → 返回最终答案
```

### 什么时候适合使用 LangChain

- 想快速创建标准 Tool Calling Agent。
- 希望统一接入多个模型厂商。
- 不想重复编写模型消息和工具调用循环。
- 需要常见的 Agent Middleware。
- 工作流程以“模型调用工具，直到完成”为主。

---

## 6. Memory

Memory 是让 Agent 保存、读取和利用过去信息的机制。

LLM 本身不会永久记住上一次 API 请求。每次调用模型时，模型只能看到本次请求中传入的 Prompt、消息和其他上下文。因此，“记忆”必须由应用程序保存，并在需要时重新提供给模型。

```text
用户说过的信息
  ↓
应用保存到 State / Checkpointer / Store / Database
  ↓
下一次调用时读取相关信息
  ↓
把信息放回模型上下文
  ↓
模型表现得像“记住了”
```

### Memory 不等于模型上下文窗口

| 概念 | 含义 |
| --- | --- |
| Context Window | 一次模型调用最多能够接收的 Token 范围 |
| Chat History | 当前对话中保存的消息列表 |
| Memory | 保存、筛选、检索并重新注入历史信息的完整机制 |

把全部聊天记录直接发送给模型，是最简单的短期记忆方式，但对话越长，成本越高，也容易超过上下文窗口。

---

### 短期记忆

短期记忆也叫 Thread-scoped Memory，作用范围是当前对话线程。

常见内容包括：

- 用户与助手的历史消息。
- 当前任务执行到了哪一步。
- 本次任务调用过的工具和结果。
- 当前上传的文件或检索到的资料。
- 当前工作流的临时变量。

在 LangGraph 中，短期记忆通常保存在 `State` 中，并通过 `Checkpointer` 按 `thread_id` 持久化。

```text
thread_id = conversation-001
│
├── messages
├── selectedRole
├── toolResults
└── currentStep
```

同一个 `thread_id` 可以继续之前的状态；不同 `thread_id` 的短期记忆彼此隔离。

### 为什么需要 Checkpointer

Checkpointer 会保存图在每一步执行后的 State 快照，因此可以实现：

- 继续之前的对话。
- Agent 中断后恢复。
- 人工审批后从原位置继续。
- 查看历史状态。
- 调试状态是在哪一步发生变化的。

开发学习时可以使用内存型 Checkpointer，生产环境通常应使用数据库支持的持久化 Checkpointer。

### 长对话如何管理

短期记忆不能无限增长，常见处理方式有：

- 删除过旧且无关的消息。
- 只保留最近若干条消息。
- 把旧消息压缩为摘要。
- 检索与当前问题相关的历史片段。
- 将稳定的用户信息转移到长期记忆。

---

### 长期记忆

长期记忆用于跨对话、跨线程保存信息。

例如用户关闭当前对话，几天后创建新对话，Agent 仍然可以记住：

- 用户喜欢 TypeScript。
- 用户当前正在学习 Agent 开发。
- 用户使用 DeepSeek。
- 项目的技术栈和编码规范。
- 过去成功完成任务的经验。

LangGraph 通常使用 `Store` 保存长期记忆，并使用自定义 Namespace 隔离不同用户或业务。

```text
Namespace: ["users", "user-001", "preferences"]

{
  "preferredLanguage": "TypeScript",
  "modelProvider": "DeepSeek",
  "learningGoal": "Agent development"
}
```

### 三类长期记忆

#### Semantic Memory：事实记忆

保存事实和用户偏好。

```text
用户使用 DeepSeek。
用户希望示例使用 TypeScript。
```

#### Episodic Memory：经历记忆

保存过去发生的任务和成功经验。

```text
上次天气工具因为城市名称格式失败，
后来通过地点标准化解决。
```

Few-shot Examples 也可以看作一种经历记忆：把过去的正确输入输出作为示例提供给模型。

#### Procedural Memory：规则记忆

保存 Agent 应该如何完成任务的规则。

```text
修改代码后必须运行 TypeScript 检查。
调用高风险工具前必须请求用户批准。
```

System Prompt、Agent 代码和固定工作流程都属于程序性知识的一部分。

### 长期记忆不是保存得越多越好

需要考虑：

- 什么信息值得记住。
- 什么时候写入记忆。
- 什么时候更新或删除旧记忆。
- 如何避免保存错误信息。
- 如何根据当前问题检索相关记忆。
- 如何保护敏感数据和用户隐私。

长期记忆可以在两个时机更新：

- Hot Path：Agent 回答用户前立即写入。
- Background：在后台异步提取和整理记忆。

---

## 7. RAG

RAG 是 Retrieval-Augmented Generation，即检索增强生成。它先从外部知识库检索与问题相关的资料，再把资料作为 Context 交给 LLM 生成回答。

```text
用户问题
   ↓
检索器 Retriever
   ↓
找到相关文档片段
   ↓
问题 + 文档片段组成 Prompt
   ↓
LLM 根据资料回答
```

### 为什么需要 RAG

LLM 的训练知识可能过时，也不知道企业内部文档和用户私有资料。直接把所有文件塞进 Prompt 又会浪费 Token，并可能超过 Context Window。

RAG 主要解决：

- 查询模型训练后出现的新知识。
- 回答企业文档、产品手册和项目代码相关问题。
- 只将与当前问题相关的内容放入上下文。
- 让回答引用可核对的资料，减少幻觉。
- 更新知识时只更新知识库，不必重新训练模型。

### RAG 的数据准备

```text
原始文件
  ↓ 加载
Document
  ↓ 清洗
干净文本
  ↓ Chunking
文档片段 Chunks
  ↓ Embedding
向量
  ↓
Vector Store
```

#### Document Loading

从 Markdown、PDF、网页或数据库中读取内容。扫描版 PDF 可能没有文字层，需要 OCR 才能提取文本。

除了正文，还应保存 Metadata：

```ts
{
  pageContent: "LangGraph 使用 State 保存工作流数据……",
  metadata: {
    source: "agent-handbook.pdf",
    page: 17,
    chapter: "LangGraph.js",
  },
}
```

#### Chunking

Chunking 是把长文档切成较小片段。片段太大，会混入无关信息并浪费 Token；片段太小，又可能丢失完整语义。

常见策略包括：

- 按字符或 Token 长度切分。
- 按标题、段落和代码块切分。
- 相邻片段保留一定重叠。
- 为每个片段保留来源和章节 Metadata。

#### Embedding

Embedding 将文本转换为数字向量。语义越相似的文本，其向量距离通常越接近。

```text
"如何保存 Agent 对话？"
        ↓ Embedding
[0.12, -0.31, 0.88, ...]
```

Embedding 模型负责表示语义，不负责生成最终自然语言答案。

### RAG 的查询流程

```text
用户问题
  ↓ 生成 Query Embedding
向量数据库相似度搜索
  ↓
Top-K 候选片段
  ↓ 可选：过滤或 Reranking
最相关片段
  ↓ Context Packing
LLM 生成有依据的答案
```

检索质量差时，即使 LLM 很强也可能答错。因此 RAG 需要分别评估“有没有检索到正确资料”和“模型有没有依据资料正确回答”。

### RAG、Memory 与数据库

| 能力 | 主要用途 |
| --- | --- |
| Memory | 保存 Agent 与用户过去交互形成的信息 |
| RAG | 从外部知识库检索与问题相关的资料 |
| Database | 可靠地保存业务事实和结构化数据 |

示例：

```text
“用户喜欢 TypeScript”              → Memory
“LangGraph 官方文档内容”            → RAG
“用户账户余额为 100 元”             → Database / 业务 API
```

三者可以一起使用，但不能相互完全替代。涉及账户、订单、权限等关键业务事实时，应该查询真实数据库或 API，而不是依赖 LLM Memory。

### RAG 不等于模型训练

RAG 不修改 LLM 参数，只是在每次请求时把检索结果放进上下文。Fine-tuning 会调整模型行为或风格，但通常不适合作为频繁更新事实知识的主要方式。

---

## 8. LangGraph.js 是什么

LangGraph 是用于构建长期运行、有状态 Agent 和工作流的底层编排框架。

它把工作流程表示为一张图：

- `State`：所有节点共享的数据。
- `Node`：一个执行步骤，例如调用模型或执行工具。
- `Edge`：节点之间的连接。
- `Conditional Edge`：根据状态决定下一步走向。
- `Checkpointer`：保存每一步的 State。
- `Store`：保存跨线程、跨会话的长期数据。

### 简化示例

```ts
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  START,
  END,
} from "@langchain/langgraph";

const State = new StateSchema({
  messages: MessagesValue,
});

async function modelNode(state: typeof State.State) {
  const response = await model.invoke(state.messages);
  return {
    messages: [response],
  };
}

const graph = new StateGraph(State)
  .addNode("model", modelNode)
  .addEdge(START, "model")
  .addEdge("model", END)
  .compile();
```

### LangGraph 主要解决的问题

- 多步骤 Agent 工作流。
- 条件分支和循环。
- 多 Agent 协作。
- 并行执行多个节点。
- 运行失败后的恢复。
- 人工审批后继续执行。
- 持久化会话状态。
- 查看或修改 Agent 的中间状态。

### 什么时候需要直接使用 LangGraph

- 标准 `createAgent` 循环无法满足需求。
- 需要“规划 → 执行 → 审查 → 修改”的固定流程。
- 工具执行前必须等待人工批准。
- 一个任务需要多个 Agent 分工。
- 需要暂停、恢复和持久化长任务。
- 需要精确控制每个节点的执行顺序。

### LangChain 与 LangGraph 的区别

| 对比项 | LangChain | LangGraph |
| --- | --- | --- |
| 抽象层级 | 高层 | 底层 |
| 核心目标 | 快速构建 LLM 应用和 Agent | 精确编排有状态工作流 |
| 主要入口 | `createAgent`、Model、Tool、Middleware | `StateGraph`、Node、Edge、State |
| 流程控制 | 使用预构建 Agent 循环 | 自己定义完整执行图 |
| 学习难度 | 相对较低 | 相对较高 |
| 适用场景 | 标准 Agent | 复杂、长期运行的 Agent |

两者不是竞争关系：

```text
LangChain Agent
      ↓ 内部使用
LangGraph Runtime
```

也可以只使用 LangGraph，并在节点中直接调用自己的模型 SDK 和工具，不强制使用 LangChain。

---

## 9. Multi-Agent

Multi-Agent 是让多个具有不同角色、Prompt、Tools 和职责的 Agent 协作完成一个复杂任务。

单个 Agent 可以同时处理很多事情，但任务越复杂，Prompt 越容易变得庞大且互相冲突。Multi-Agent 通过专业分工降低每个 Agent 的职责范围。

```text
Manager Agent
├── Researcher Agent：检索资料
├── Developer Agent：编写代码
└── Reviewer Agent：审查结果
```

### 为什么使用 Multi-Agent

- 不同任务需要不同角色 Prompt。
- 不同 Agent 可以拥有不同工具权限。
- 复杂任务可以拆成更小、更明确的子任务。
- 可以加入独立 Reviewer，降低错误结果直接交付的风险。
- 独立子任务可以并行处理。

### 常见协作模式

#### Supervisor / Manager

Manager 接收用户目标、拆分任务、选择专业 Agent，并汇总最终结果。

```text
用户 → Manager → Researcher
              → Developer
              → Reviewer
              → 最终答案
```

#### Handoff

当前 Agent 根据任务类型把控制权移交给另一个 Agent。例如客服 Agent 判断用户需要技术支持后，转交给 Technical Support Agent。

#### Pipeline

多个 Agent 按固定顺序处理：

```text
需求分析 → 方案设计 → 代码实现 → 代码审查
```

#### Parallel

多个 Agent 同时处理互不依赖的子任务，再由聚合节点合并结果。

### Agent 之间传递什么

Agent 不应默认共享全部内部状态。通常只传递完成下一步所需的信息：

- 原始目标。
- 明确的子任务。
- 必要上下文和资料。
- 结构化执行结果。
- 错误、风险和未解决问题。

使用结构化输出可以减少 Agent 之间因为自然语言含糊产生的误解。

### Multi-Agent 与 LangGraph

LangGraph 可以把每个 Agent 当作一个 Node 或 Subgraph：

```text
START
  ↓
Manager Node
  ↓ 条件路由
Researcher / Developer / Reviewer
  ↓
Aggregator Node
  ↓
END
```

State 保存共享任务数据，Conditional Edge 决定下一位 Agent，Checkpointer 保存执行进度，Interrupt 可以在关键步骤等待人工审批。

### Multi-Agent 的代价

- 增加模型调用次数和 Token 成本。
- 增加延迟、状态管理和调试难度。
- Agent 之间可能重复工作或互相传递错误信息。
- 如果职责边界不清晰，多 Agent 可能不如单 Agent 稳定。

因此，简单任务优先使用单 Agent。只有在职责、权限、上下文或流程确实需要隔离时，再引入 Multi-Agent。

### 当前项目如何扩展

当前项目已有多个角色 Prompt，可以逐步升级为：

```text
Product Manager Agent
        ↓ 输出需求
Web Fullstack Engineer Agent
        ↓ 输出实现
Code Reviewer Agent
        ↓ 输出审查意见
Engineer Agent
        ↓ 修复问题
最终结果
```

第一步不必立即创建多个模型服务。可以先用 LangGraph 将现有角色作为不同节点，复用同一个 DeepSeek Provider，但给每个节点配置不同 Prompt 和 Tools。

---

## 10. 与当前 ChatDemo 项目的对应关系

当前项目已经具备 LangChain Agent 的部分基础能力，但采用的是原生 SDK 手动实现：

| 当前项目能力 | 对应概念 |
| --- | --- |
| `openaiCompatibleProvider.ts` | Model 调用与手写 Agent Loop |
| `toolSchemas` | Tool 定义 |
| `toolExecutor.ts` | 工具执行节点 |
| Prompt 角色文件 | System Prompt |
| React 对话页面 | Agent Harness UI |
| SSE Streaming | 流式响应 |
| 前端消息数组 | 临时的短期记忆 |

当前项目的消息主要由前端保存并随请求发送。页面刷新或服务重启后能否恢复，取决于是否另外使用了浏览器存储或后端数据库。

如果要加入正式 Memory，可以按下面顺序学习：

1. 给每个对话生成唯一 `thread_id`。
2. 在后端保存每个线程的消息历史。
3. 限制历史长度并加入摘要策略。
4. 保存用户偏好等长期记忆。
5. 每次请求只检索并注入相关记忆。
6. 最后再考虑迁移到 LangGraph Checkpointer 和 Store。

---

## 11. 如何选择

### 只使用原生 DeepSeek SDK

适合学习底层原理，所有 Tool Calling、循环和 Memory 都需要自己实现。当前 ChatDemo 就接近这种方式。

### 使用 LangChain

适合快速实现标准 Agent，减少 Provider、Tool 和 Agent Loop 的重复代码。

### 使用 LangGraph

适合复杂工作流、持久化任务、人工审批、多 Agent 和精确流程控制。

### 使用 LangChain + LangGraph

这是常见组合：

```text
LangChain：模型、工具、Prompt、createAgent
LangGraph：状态、流程、持久化、Memory
```

建议的学习顺序：

```text
原生 SDK 与 Tool Calling
        ↓
LangChain Model / Tool / createAgent
        ↓
LangGraph State / Node / Edge
        ↓
Checkpointer 与短期记忆
        ↓
Store 与长期记忆
        ↓
Human-in-the-loop / Multi-Agent
```

---

## 12. 最终记忆口诀

```text
LLM：负责理解语言、选择行动并生成回答。

LangChain：把组件接起来，快速创建 Agent。

LangGraph：把步骤画成图，控制 Agent 的运行过程。

Memory：把过去的信息保存起来，在未来需要时重新交给 Agent。

Prompt：告诉 Agent 应该扮演谁、完成什么以及如何回答。

Tools：让 Agent 能够查询真实信息并执行外部动作。

RAG：从外部知识库中找出相关资料，再让 LLM 依据资料回答。

Multi-Agent：让多个职责明确的 Agent 分工、协作和相互审查。
```

## 参考资料

- [LangChain 官方概览](https://docs.langchain.com/oss/javascript/langchain/overview)
- [LangChain Agents](https://docs.langchain.com/oss/javascript/langchain/agents)
- [LangGraph 官方概览](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Memory 官方概览](https://docs.langchain.com/oss/javascript/concepts/memory)
- [LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
