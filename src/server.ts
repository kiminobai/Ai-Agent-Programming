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
  (_req: Request, res: Response<{ roles: Array<Omit<PromptRole, "systemPrompt">>; defaultRoleId: string }>) => {
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
  const userMessage = req.body?.message?.trim();
  const modelId = req.body?.modelId?.trim();
  const roleId = req.body?.roleId?.trim() || appConfig.defaultRoleId;

  if (!userMessage) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  if (!modelId) {
    res.status(400).json({ error: "modelId is required." });
    return;
  }

  const model = getModelById(modelId);
  if (!model) {
    res.status(404).json({ error: "Model was not found." });
    return;
  }

  const role = getPromptRoleById(roleId);
  if (!role) {
    res.status(404).json({ error: "Role was not found." });
    return;
  }

  const provider = providers.get(model.provider);
  if (!provider || !provider.isAvailable()) {
    res.status(400).json({
      error: `${model.label} is not available. Check the related API key configuration.`
    });
    return;
  }

  try {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const meta = {
      provider: model.provider,
      modelId: model.id,
      modelLabel: model.label,
      roleId: role.id
    };

    res.write(`data: ${JSON.stringify({ type: "meta", meta })}\n\n`);

    const reply = await provider.streamChat(
      model.id,
      userMessage,
      role.systemPrompt,
      (chunk) => {
        res.write(`data: ${JSON.stringify({ type: "delta", chunk })}\n\n`);
      },
      role.fewShotExamples
    );

    res.write(`data: ${JSON.stringify({ type: "done", reply, meta })}\n\n`);
    res.end();
  } catch (error) {
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
