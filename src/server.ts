/**
 * Express 应用入口：提供模型/角色、线程列表和 SSE 流式聊天接口。
 */
import express, { Request, RequestHandler, Response } from "express";
import path from "path";
import { appConfig } from "./config";
import { getModelById, getPublicModels } from "./modelRegistry";
import { getPromptRoleById, promptRoles } from "./prompts";
import { createProviderRegistry } from "./providerRegistry";
import { LangChainProvider } from "./providers/langChainProvider";
import {
  createThread,
  getThreadById,
  listThreadsByUser,
  renameThread,
  updateThreadAfterMessage
} from "./threads/threadRepository";
import { ChatRequestPayload, PromptRole, ReasoningEffort } from "./types";

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

app.get("/api/threads", (req: Request, res: Response) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }

  res.json({
    threads: listThreadsByUser(userId)
  });
});

app.post(
  "/api/threads",
  (
    req: Request<
      Record<string, string>,
      { error: string },
      {
        userId: string;
        modelId: string;
        roleId: string;
        reasoningEffort?: ReasoningEffort;
      }
    >,
    res: Response
  ) => {
    const userId = req.body?.userId?.trim();
    const modelId = req.body?.modelId?.trim();
    const roleId = req.body?.roleId?.trim() || appConfig.defaultRoleId;

    if (!userId) {
      res.status(400).json({ error: "userId is required." });
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

    const thread = createThread({
      userId,
      providerId: model.provider,
      modelId: model.id,
      roleId: role.id,
      reasoningEffort:
        model.provider === "openai" ? req.body?.reasoningEffort : undefined
    });

    res.json({ thread });
  }
);

app.get("/api/threads/:threadId", (req: Request, res: Response) => {
  const userId = String(req.query.userId || "").trim();
  const threadId = String(req.params.threadId || "").trim();

  if (!userId || !threadId) {
    res.status(400).json({ error: "userId and threadId are required." });
    return;
  }

  const thread = getThreadById(threadId, userId);
  if (!thread) {
    res.status(404).json({ error: "Thread was not found." });
    return;
  }

  res.json({ thread });
});

app.patch(
  "/api/threads/:threadId",
  (
    req: Request<
      Record<string, string>,
      { error: string },
      { userId: string; title: string }
    >,
    res: Response
  ) => {
    const userId = req.body?.userId?.trim();
    const title = req.body?.title?.trim();
    const threadId = String(req.params.threadId || "").trim();

    if (!userId || !threadId) {
      res.status(400).json({ error: "userId and threadId are required." });
      return;
    }

    if (!title) {
      res.status(400).json({ error: "title is required." });
      return;
    }

    const thread = renameThread(threadId, userId, title);
    if (!thread) {
      res.status(404).json({ error: "Thread was not found." });
      return;
    }

    res.json({ thread });
  }
);

app.get("/api/threads/:threadId/messages", async (req: Request, res: Response) => {
  const userId = String(req.query.userId || "").trim();
  const threadId = String(req.params.threadId || "").trim();

  if (!userId || !threadId) {
    res.status(400).json({ error: "userId and threadId are required." });
    return;
  }

  const thread = getThreadById(threadId, userId);
  if (!thread) {
    res.status(404).json({ error: "Thread was not found." });
    return;
  }

  const role = getPromptRoleById(thread.roleId);
  if (!role) {
    res.status(404).json({ error: "Role was not found." });
    return;
  }

  const provider = providers.get(thread.providerId);
  if (!(provider instanceof LangChainProvider)) {
    res.status(400).json({ error: "Thread provider does not support history loading." });
    return;
  }

  try {
    const messages = await provider.getThreadMessages(
      thread.modelId,
      role.systemPrompt,
      thread.threadId,
      role.fewShotExamples,
      thread.reasoningEffort
    );

    res.json({ thread, messages });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load thread messages.";
    res.status(500).json({ error: message });
  }
});

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
  const threadId = req.body?.threadId?.trim();
  const userId = req.body?.userId?.trim();
  const reasoningEffort = req.body?.reasoningEffort;

  if (!userMessage) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  if (!modelId) {
    res.status(400).json({ error: "modelId is required." });
    return;
  }

  if (!threadId) {
    res.status(400).json({ error: "threadId is required." });
    return;
  }

  if (!userId) {
    res.status(400).json({ error: "userId is required." });
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

  const thread = getThreadById(threadId, userId);
  if (!thread) {
    res.status(404).json({ error: "Thread was not found. Please create a new chat first." });
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
      roleId: role.id,
      userId,
      threadId
    };

    res.write(`data: ${JSON.stringify({ type: "meta", meta })}\n\n`);

    const reply = await provider.streamChat(
      model.id,
      userMessage,
      role.systemPrompt,
      (chunk) => {
        res.write(`data: ${JSON.stringify({ type: "delta", chunk })}\n\n`);
      },
      role.fewShotExamples,
      model.provider === "openai" ? reasoningEffort : undefined,
      threadId,
      userId
    );

    updateThreadAfterMessage({
      threadId,
      userId,
      providerId: model.provider,
      modelId: model.id,
      roleId: role.id,
      reasoningEffort: model.provider === "openai" ? reasoningEffort : undefined,
      userMessage
    });

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
