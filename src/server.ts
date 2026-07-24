/**
 * Express 应用入口：提供模型/角色列表和 SSE 流式聊天接口。
 */
import express, { Request, RequestHandler, Response } from "express";
import path from "path";
import { appConfig } from "./config";
import { getModelById, getPublicModels } from "./modelRegistry";
import { getPromptRoleById, promptRoles } from "./prompts";
import { createProviderRegistry } from "./providerRegistry";
import { ChatRequestPayload, PromptRole } from "./types";

const app = express();
const providers = createProviderRegistry();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/models", (_req: Request, res: Response) => {
  res.json({
    models: getPublicModels(providers)
  });
});

app.get(
  "/api/roles",
  (
    _req: Request,
    res: Response<{
      roles: Array<Omit<PromptRole, "systemPrompt">>;
      defaultRoleId: string;
    }>
  ) => {
    res.json({
      roles: promptRoles.map(({ systemPrompt, ...role }) => role),
      defaultRoleId: appConfig.defaultRoleId
    });
  }
);

const chatHandler: RequestHandler<
  Record<string, string>,
  { error: string },
  ChatRequestPayload
> = async (
  req: Request<Record<string, string>, { error: string }, ChatRequestPayload>,
  res: Response<{ error: string }>
): Promise<void> => {
  // 步骤 1：读取并规范化前端提交的消息、模型、角色与推理强度。
  const userMessage = req.body?.message?.trim();
  const modelId = req.body?.modelId?.trim();
  const roleId = req.body?.roleId?.trim() || appConfig.defaultRoleId;
  const reasoningEffort = req.body?.reasoningEffort;

  // 步骤 2：在调用任何模型之前验证必填输入。
  if (!userMessage) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  if (!modelId) {
    res.status(400).json({ error: "modelId is required." });
    return;
  }

  // 步骤 3：模型必须来自服务端白名单，不能相信前端任意 modelId。
  const model = getModelById(modelId);
  if (!model) {
    res.status(404).json({ error: "Model was not found." });
    return;
  }

  // 步骤 4：取得角色 System Prompt 与专属 Few-shot Examples。
  const role = getPromptRoleById(roleId);
  if (!role) {
    res.status(404).json({ error: "Role was not found." });
    return;
  }

  // 步骤 5：按模型所属厂商，从 Registry 选择统一 Provider 实现。
  const provider = providers.get(model.provider);
  if (!provider || !provider.isAvailable()) {
    res.status(400).json({
      error: `${model.label} is not available. Check the related API key configuration.`
    });
    return;
  }

  try {
    // 步骤 6：将普通 HTTP 响应升级为 SSE 长连接。
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // 步骤 7：先发送 meta，前端可立即显示实际模型与角色。
    const meta = {
      provider: model.provider,
      modelId: model.id,
      modelLabel: model.label,
      roleId: role.id
    };

    res.write(`data: ${JSON.stringify({ type: "meta", meta })}\n\n`);

    // 步骤 8：Provider 内部执行模型调用或 Tool Agent 循环。
    const reply = await provider.streamChat(
      model.id,
      userMessage,
      role.systemPrompt,
      (chunk) => {
        // 步骤 9：每个模型文本增量包装为 delta SSE 事件。
        res.write(`data: ${JSON.stringify({ type: "delta", chunk })}\n\n`);
      },
      role.fewShotExamples,
      model.provider === "openai" ? reasoningEffort : undefined
    );

    // 步骤 10：Agent 完成后发送完整答案并正常关闭连接。
    res.write(`data: ${JSON.stringify({ type: "done", reply, meta })}\n\n`);
    res.end();
  } catch (error) {
    // 步骤 11：区分“尚未发响应”和“SSE 已开始”两种错误返回方式。
    const message =
      error instanceof Error ? error.message : "Unknown error while requesting the model.";

    if (!res.headersSent) {
      res.status(500).json({ error: message });
      return;
    }

    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    res.end();
  }
};

app.post("/api/chat", chatHandler);

app.listen(appConfig.port, appConfig.host, () => {
  console.log(`Chat Demo is running at http://${appConfig.host}:${appConfig.port}`);
});
