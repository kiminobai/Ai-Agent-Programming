import express, { Request, RequestHandler, Response } from "express";
import path from "path";
import { appConfig } from "./config";
import { getModelById, getPublicModels } from "./modelRegistry";
import { getPromptRoleById, promptRoles } from "./prompts";
import { createProviderRegistry } from "./providerRegistry";
import { ChatRequestPayload, ChatResponsePayload, PromptRole } from "./types";

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
  (_req: Request, res: Response<{ roles: Array<Omit<PromptRole, "systemPrompt">>; defaultRoleId: string }>) => {
    res.json({
      roles: promptRoles.map(({ systemPrompt, ...role }) => role),
      defaultRoleId: appConfig.defaultRoleId
    });
  }
);

const chatHandler: RequestHandler<
  Record<string, string>,
  ChatResponsePayload | { error: string },
  ChatRequestPayload
> = async (
  req: Request<
    Record<string, string>,
    ChatResponsePayload | { error: string },
    ChatRequestPayload
  >,
  res: Response<ChatResponsePayload | { error: string }>
): Promise<void> => {
  const userMessage = req.body?.message?.trim();
  const modelId = req.body?.modelId?.trim();
  const roleId = req.body?.roleId?.trim() || appConfig.defaultRoleId;

  if (!userMessage) {
    res.status(400).json({
      error: "message 不能为空。"
    });
    return;
  }

  if (!modelId) {
    res.status(400).json({
      error: "modelId 不能为空。"
    });
    return;
  }

  const model = getModelById(modelId);
  if (!model) {
    res.status(404).json({
      error: "未找到对应模型，请重新选择。"
    });
    return;
  }

  const role = getPromptRoleById(roleId);
  if (!role) {
    res.status(404).json({
      error: "未找到对应角色，请重新选择。"
    });
    return;
  }

  const provider = providers.get(model.provider);
  if (!provider || !provider.isAvailable()) {
    res.status(400).json({
      error: `${model.label} 当前不可用，请检查对应的 API Key 是否已配置。`
    });
    return;
  }

  try {
    const reply = await provider.sendChat(
      model.id,
      userMessage,
      role.systemPrompt,
      role.fewShotExamples
    );

    res.json({
      reply,
      meta: {
        provider: model.provider,
        modelId: model.id,
        modelLabel: model.label,
        roleId: role.id
      }
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "请求模型时发生未知异常。"
    });
  }
};

app.post("/api/chat", chatHandler);

app.listen(appConfig.port, appConfig.host, () => {
  console.log(`Chat Demo is running at http://${appConfig.host}:${appConfig.port}`);
});
