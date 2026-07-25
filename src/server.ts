/**
 * Express entrypoint for the chat demo.
 *
 * Responsibilities:
 * - serve static assets
 * - expose models, roles, threads, and message history
 * - stream chat responses over SSE
 * - accept optional user-uploaded attachments inside the chat request
 */
import express, { Request, RequestHandler, Response } from "express";
import multer from "multer";
import path from "path";
import { appConfig } from "./config";
import { getModelById, getPublicModels } from "./modelRegistry";
import { getPromptRoleById, promptRoles } from "./prompts";
import { createProviderRegistry } from "./providerRegistry";
import { LangChainProvider } from "./providers/langChainProvider";
import { createUploadedDocumentRecord } from "./rag/documentChunkLab";
import { deleteUploadThreadDirectory, saveUploadFile } from "./rag/uploadFileStorage";
import { getUploadedDocument, saveUploadedDocument } from "./rag/uploadedDocumentStore";
import { searchVectorDocumentIndex } from "./rag/vectorDocumentIndex";
import {
  createThread,
  deleteThread,
  getThreadById,
  listThreadsByUser,
  renameThread,
  updateThreadAfterMessage
} from "./threads/threadRepository";
import { ChatRequestPayload, PromptRole, ReasoningEffort } from "./types";

type MulterRequest = Request & {
  file?: Express.Multer.File;
};

const app = express();
const providers = createProviderRegistry();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // Attachments are meant for prompt/RAG experiments, not bulk archival uploads.
    fileSize: 10 * 1024 * 1024
  }
});

/**
 * Chat requests may arrive as JSON or multipart/form-data.
 * We only invoke multer when the client actually sends multipart content.
 */
const maybeChatUpload: RequestHandler = (req, res, next) => {
  if (req.is("multipart/form-data")) {
    upload.single("attachment")(req, res, next);
    return;
  }

  next();
};

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

app.delete("/api/threads/:threadId", async (req: Request, res: Response) => {
  const userId = String(req.query.userId || "").trim();
  const threadId = String(req.params.threadId || "").trim();

  if (!userId || !threadId) {
    res.status(400).json({ error: "userId and threadId are required." });
    return;
  }

  try {
    const deleted = deleteThread(threadId, userId);
    if (!deleted) {
      res.status(404).json({ error: "Thread was not found." });
      return;
    }

    await deleteUploadThreadDirectory({ userId, threadId });
    res.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to delete thread.";
    res.status(500).json({ error: message });
  }
});

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

app.post(
  "/api/documents/qa",
  async (
    req: Request<
      Record<string, string>,
      { error: string },
      {
        userId: string;
        threadId: string;
        modelId: string;
        roleId?: string;
        question: string;
        reasoningEffort?: ReasoningEffort;
      }
    >,
    res: Response
  ) => {
    const userId = req.body?.userId?.trim();
    const threadId = req.body?.threadId?.trim();
    const modelId = req.body?.modelId?.trim();
    const roleId = req.body?.roleId?.trim() || appConfig.defaultRoleId;
    const question = req.body?.question?.trim();
    const reasoningEffort = req.body?.reasoningEffort;

    if (!userId || !threadId || !modelId || !question) {
      res.status(400).json({
        error: "userId, threadId, modelId, and question are required."
      });
      return;
    }

    const thread = getThreadById(threadId, userId);
    if (!thread) {
      res.status(404).json({ error: "Thread was not found." });
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

    const document = getUploadedDocument(threadId);
    if (!document) {
      res.status(404).json({
        error: "No uploaded document is attached to this thread."
      });
      return;
    }

    if (!document.text.trim()) {
      res.status(400).json({
        error:
          "The uploaded file was saved, but this file type has no extracted text for document QA yet."
      });
      return;
    }

    try {
      const retrieval = await searchVectorDocumentIndex(document, question);
      const sources = retrieval.chunks.map((chunk) => ({
        sourceId: `chunk-${chunk.index}`,
        chunkIndex: chunk.index,
        similarity: chunk.similarity,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
        matchedTerms: chunk.matchedTerms,
        contentPreview: chunk.content
      }));
      const context = retrieval.chunks
        .map((chunk) =>
          [
            `[Source: chunk-${chunk.index}]`,
            `Similarity: ${chunk.similarity}`,
            `Character range: ${chunk.startChar}-${chunk.endChar}`,
            chunk.content
          ].join("\n")
        )
        .join("\n\n---\n\n");
      const qaPrompt = [
        "Answer the user's question using only the retrieved document context below.",
        "If the answer is not present in the context, say that the current retrieved document chunks do not contain enough information.",
        "When you use a source, cite it inline with the format [chunk-N].",
        "End with a short 'Sources' line listing the source ids you used, such as: Sources: [chunk-0], [chunk-3].",
        "",
        `Document: ${document.fileName}`,
        "",
        "[Retrieved document context]",
        context,
        "",
        "[Question]",
        question
      ].join("\n");
      const answer = await provider.sendChat(
        model.id,
        qaPrompt,
        role.systemPrompt,
        role.fewShotExamples,
        model.provider === "openai" ? reasoningEffort : undefined,
        `${threadId}:document-qa`,
        userId
      );

      res.json({
        answer,
        document: {
          fileId: document.fileId,
          fileName: document.fileName,
          fileType: document.fileType,
          storageKey: document.storageKey,
          parseStatus: document.parseStatus,
          indexStatus: document.indexStatus
        },
        retrieval: {
          strategy: "local-vector-cosine",
          topK: retrieval.chunks.length,
          totalChunks: retrieval.index.chunkCount,
          sources
        }
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Document QA request failed.";
      res.status(500).json({ error: message });
    }
  }
);

const chatHandler: RequestHandler = async (
  rawReq,
  res: Response<{ error: string }>
): Promise<void> => {
  const req = rawReq as MulterRequest;
  const body = req.body as Partial<ChatRequestPayload>;
  const attachment = req.file;

  const userMessage = body?.message?.trim();
  const modelId = body?.modelId?.trim();
  const roleId = body?.roleId?.trim() || appConfig.defaultRoleId;
  const threadId = body?.threadId?.trim();
  const userId = body?.userId?.trim();
  const reasoningEffort = body?.reasoningEffort;
  const attachmentName = body?.attachmentName?.trim() || attachment?.originalname?.trim();
  const effectiveUserMessage =
    userMessage ||
    (attachmentName ? `I uploaded a file named ${attachmentName}.` : "");

  if (!effectiveUserMessage) {
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
    /**
     * If the user attached a document to this message, we parse it once here and
     * bind it to the current thread. The model may later decide whether to use the
     * uploaded-document tool based on the user's intent.
     */
    if (attachment) {
      const storedUpload = await saveUploadFile({
        userId,
        threadId,
        originalName: attachment.originalname,
        buffer: attachment.buffer
      });
      const uploadedDocument = await createUploadedDocumentRecord({
        threadId,
        userId,
        fileId: storedUpload.fileId,
        fileName: attachment.originalname,
        storageKey: storedUpload.storageKey,
        mimeType: attachment.mimetype,
        fileSize: attachment.size,
        fileBuffer: attachment.buffer
      });
      saveUploadedDocument(uploadedDocument);
    }

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

    /**
     * 把“本轮确实带了附件”显式写进发给模型的用户消息里。
     * 这样模型在当前回合就能感知附件存在，而不是只依赖中间件里的通用背景提示。
     */
    const messageForModel = attachmentName
      ? [
          effectiveUserMessage,
          "",
          `[Attachment available in current thread: ${attachmentName}]`,
          "If the user asks to use the file content, call retrieve_uploaded_document_chunks to retrieve only relevant chunks before answering."
        ].join("\n")
      : effectiveUserMessage;

    const reply = await provider.streamChat(
      model.id,
      messageForModel,
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
      userMessage: effectiveUserMessage
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

app.post("/api/chat", maybeChatUpload, chatHandler);

app.listen(appConfig.port, appConfig.host, () => {
  console.log(`Chat Demo is running at http://${appConfig.host}:${appConfig.port}`);
});
