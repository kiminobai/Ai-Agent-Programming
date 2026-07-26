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
import { appConfig, getProviderConfig } from "./config";
import { getModelById, getPublicModels } from "./modelRegistry";
import { getPromptRoleById, promptRoles } from "./prompts";
import { createProviderRegistry } from "./providerRegistry";
import { LangChainProvider } from "./providers/langChainProvider";
import { answerQuestionWithImage } from "./providers/visionQaProvider";
import { createUploadedDocumentRecord } from "./rag/documentChunkLab";
import {
  deleteUploadThreadDirectory,
  resolveUploadStorageKey,
  saveUploadFile
} from "./rag/uploadFileStorage";
import {
  getUploadedDocument,
  getUploadedDocumentByFileId,
  saveUploadedDocument
} from "./rag/uploadedDocumentStore";
import { selectDocumentRagArchitecture } from "./rag/ragArchitectureRouter";
import { searchKnowledgeBase } from "./rag/knowledgeBaseRetriever";
import {
  searchHybridDocumentIndex,
  searchVectorDocumentIndex
} from "./rag/vectorDocumentIndex";
import {
  createThread,
  deleteThread,
  getThreadById,
  listThreadsByUser,
  renameThread,
  updateThreadAfterMessage
} from "./threads/threadRepository";
import {
  listDocumentQaMessages,
  saveDocumentQaExchange
} from "./threads/documentQaHistoryRepository";
import {
  ChatProvider,
  ChatRequestPayload,
  PromptRole,
  ReasoningEffort
} from "./types";

type MulterRequest = Request & {
  file?: Express.Multer.File;
};

function decodeUploadedFileName(fileName: string): string {
  // 学习点：浏览器上传中文文件名时，multer 有时会按 latin1 读出来。
  // 为什么这样：这里尝试转回 UTF-8，避免前端显示文件名乱码。
  const decoded = Buffer.from(fileName, "latin1").toString("utf8");
  const countChinese = (value: string) =>
    [...value].filter((char) => /[\u4e00-\u9fff]/.test(char)).length;
  const hasMojibake = /[ÃÂ]|å.|æ.|ä./.test(fileName);

  if (hasMojibake || countChinese(decoded) > countChinese(fileName)) {
    return decoded;
  }

  return fileName;
}

const app = express();
const providers = createProviderRegistry();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // Office files and image uploads can be larger than plain prompt documents.
    fileSize: 50 * 1024 * 1024
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

async function validateDocumentAnswer(input: {
  provider: ChatProvider;
  modelId: string;
  systemPrompt: string;
  question: string;
  context: string;
  answer: string;
  threadId: string;
  userId: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<string> {
  // 学习点：这是 Answer Validation。
  // 为什么这样：Hybrid RAG 检索到的片段可能不完整，先让模型检查回答是否被上下文支持，再返回给用户。
  const validationPrompt = [
    "You are validating a RAG answer before it is shown to the user.",
    "Check whether the answer is supported by the retrieved document context.",
    "Return strict JSON only, with this shape:",
    '{"supported":true,"finalAnswer":"..."}',
    "If the answer contains unsupported claims, rewrite it into a grounded answer using only the context.",
    "Do not include raw chunk ids, similarity scores, or a Sources line in finalAnswer.",
    "",
    "[Question]",
    input.question,
    "",
    "[Retrieved context]",
    input.context,
    "",
    "[Draft answer]",
    input.answer
  ].join("\n");

  try {
    const validation = await input.provider.sendChat(
      input.modelId,
      validationPrompt,
      input.systemPrompt,
      [],
      input.reasoningEffort,
      `${input.threadId}:answer-validation`,
      input.userId
    );
    const jsonText = extractJsonObject(validation);
    if (!jsonText) {
      return input.answer;
    }

    const parsed = JSON.parse(jsonText) as {
      supported?: boolean;
      finalAnswer?: string;
    };
    return parsed.finalAnswer?.trim() || input.answer;
  } catch {
    return input.answer;
  }
}

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return "";
  }

  return value.slice(start, end + 1);
}

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

app.get("/api/files/:fileId", (req: Request, res: Response) => {
  const userId = String(req.query.userId || "").trim();
  const fileId = String(req.params.fileId || "").trim();

  if (!userId || !fileId) {
    res.status(400).json({ error: "userId and fileId are required." });
    return;
  }

  const document = getUploadedDocumentByFileId(fileId, userId);
  if (!document || !document.storageKey) {
    res.status(404).json({ error: "File was not found." });
    return;
  }

  res.setHeader("Content-Type", document.mimeType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(document.originalName)}`
  );
  res.sendFile(resolveUploadStorageKey(document.storageKey));
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
    const documentQaMessages = listDocumentQaMessages(threadId, userId);

    res.json({ thread, messages: [...messages, ...documentQaMessages] });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load thread messages.";
    res.status(500).json({ error: message });
  }
});

app.post(
  "/api/documents/upload",
  maybeChatUpload,
  async (rawReq, res: Response) => {
    // 学习点：上传接口只负责“保存文件 + 建立文档记录”，不会直接让 AI 分析。
    // 为什么这样：是否分析、怎么分析，要等用户在聊天框里明确发送问题后再由 Agent/RAG 决定。
    const req = rawReq as MulterRequest;
    const userId = String(req.body?.userId || "").trim();
    const threadId = String(req.body?.threadId || "").trim();
    const attachment = req.file;

    if (!userId || !threadId || !attachment) {
      res.status(400).json({
        error: "userId, threadId, and attachment are required."
      });
      return;
    }

    const thread = getThreadById(threadId, userId);
    if (!thread) {
      res.status(404).json({ error: "Thread was not found." });
      return;
    }

    try {
      const originalName = decodeUploadedFileName(attachment.originalname);
      // 步骤 1：原始文件保存到 data/uploads，数据库只保存相对 storageKey。
      // 这样部署时不会把文件路径和本机盘符写死。
      const storedUpload = await saveUploadFile({
        userId,
        threadId,
        originalName,
        buffer: attachment.buffer
      });
      // 步骤 2：解析文件类型和可检索文本，形成 uploadedDocument 记录。
      // PDF/Office/图片会在这里进入不同解析路径。
      const uploadedDocument = await createUploadedDocumentRecord({
        threadId,
        userId,
        fileId: storedUpload.fileId,
        fileName: originalName,
        storageKey: storedUpload.storageKey,
        mimeType: attachment.mimetype,
        fileSize: attachment.size,
        fileBuffer: attachment.buffer
      });

      // 步骤 3：把文档元数据写入 SQLite。
      // 后续刷新页面、继续对话、删除对话时都依赖这条记录。
      saveUploadedDocument(uploadedDocument);

      res.json({
        document: {
          fileId: uploadedDocument.fileId,
          fileName: uploadedDocument.fileName,
          fileType: uploadedDocument.fileType,
          fileSize: uploadedDocument.fileSize,
          storageKey: uploadedDocument.storageKey,
          parseStatus: uploadedDocument.parseStatus,
          indexStatus: uploadedDocument.indexStatus
        }
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to upload document.";
      res.status(500).json({ error: message });
    }
  }
);

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
    // 学习点：这是“当前对话上传文件”的问答接口。
    // 为什么这样：它只查当前 thread 绑定的文件，不会自动查长期知识库，避免上下文来源混乱。
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

    if (document.fileType === "image") {
      // 学习点：图片不是普通文本 RAG。
      // 为什么这样：DeepSeek 当前配置不能直接看图，只有支持视觉的模型才适合进入图片理解流程。
      const sources = [
        {
          sourceId: "image-0",
          chunkIndex: 0,
          similarity: model.supportsVision && model.provider === "openai" ? 1 : 0,
          startChar: 0,
          endChar: 0,
          matchedTerms: [],
          contentPreview: `\u56fe\u7247\u6587\u4ef6\uff1a${document.fileName}`
        }
      ];

      try {
        const answer =
          model.supportsVision && model.provider === "openai"
            ? await answerQuestionWithImage({
                config: getProviderConfig(model.provider),
                modelId: model.id,
                imagePath: resolveUploadStorageKey(document.storageKey),
                mimeType: document.mimeType,
                question,
                systemPrompt: role.systemPrompt
              })
            : "\u5f53\u524d\u9009\u62e9\u7684\u6a21\u578b\u4e0d\u80fd\u76f4\u63a5\u7406\u89e3\u56fe\u7247\u5185\u5bb9\uff0c\u6240\u4ee5\u65e0\u6cd5\u53ef\u9760\u5206\u6790\u8fd9\u5f20\u56fe\u7247\u3002\u4f60\u53ef\u4ee5\u5207\u6362\u5230\u652f\u6301\u56fe\u7247\u7406\u89e3\u7684\u6a21\u578b\uff0c\u4f8b\u5982 OpenAI GPT-4o Mini\uff1b\u6216\u8005\u4e0a\u4f20\u5305\u542b\u6587\u5b57\u5185\u5bb9\u7684 PDF\u3001Word\u3001Excel\u3001PPTX \u7b49\u6587\u4ef6\u3002";

        saveDocumentQaExchange({
          threadId,
          userId,
          question,
          answer,
          attachmentName: document.fileName,
          attachmentFileId: document.fileId,
          sources
        });
        updateThreadAfterMessage({
          threadId,
          userId,
          providerId: model.provider,
          modelId: model.id,
          roleId: role.id,
          reasoningEffort: model.provider === "openai" ? reasoningEffort : undefined,
          userMessage: question
        });

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
            strategy:
              model.supportsVision && model.provider === "openai"
                ? "image-understanding-model"
                : "unsupported-image-model",
            topK: 0,
            totalChunks: 0,
            sources
          }
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "\u56fe\u7247\u5206\u6790\u8bf7\u6c42\u5931\u8d25\u3002";
        res.status(500).json({ error: message });
      }

      return;
    }

    if (false as boolean) {
      const sources = [
        {
          sourceId: "image-0",
          chunkIndex: 0,
          similarity: model.supportsVision && model.provider === "openai" ? 1 : 0,
          startChar: 0,
          endChar: 0,
          matchedTerms: [],
          contentPreview: `图片文件：${document.fileName}`
        }
      ];

      try {
        const answer =
          model.supportsVision && model.provider === "openai"
            ? await answerQuestionWithImage({
                config: getProviderConfig(model.provider),
                modelId: model.id,
                imagePath: resolveUploadStorageKey(document.storageKey),
                mimeType: document.mimeType,
                question,
                systemPrompt: role.systemPrompt
              })
            : "当前选择的模型不能直接理解图片内容，所以无法可靠分析这张图片。你可以切换到支持图片理解的模型，例如 OpenAI GPT-4o Mini；或者上传包含文字内容的 PDF、Word、Excel、PPTX 等文件。";

        saveDocumentQaExchange({
          threadId,
          userId,
          question,
          answer,
          attachmentName: document.fileName,
          attachmentFileId: document.fileId,
          sources
        });
        updateThreadAfterMessage({
          threadId,
          userId,
          providerId: model.provider,
          modelId: model.id,
          roleId: role.id,
          reasoningEffort: model.provider === "openai" ? reasoningEffort : undefined,
          userMessage: question
        });

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
            strategy:
              model.supportsVision && model.provider === "openai"
                ? "image-understanding-model"
                : "unsupported-image-model",
            topK: 0,
            totalChunks: 0,
            sources
          }
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "图片分析请求失败。";
        res.status(500).json({ error: message });
      }

      return;
    }

    if (false as boolean && (document as { fileType: string }).fileType === "image") {
      if (!model.supportsVision || model.provider !== "openai") {
        res.status(400).json({
          error:
            "当前选择的模型不能直接理解图片内容，所以无法可靠分析这张图片。你可以切换到支持图片理解的模型，例如 OpenAI GPT-4o Mini；或者上传包含文字内容的 PDF、Word、Excel、PPTX 等文件。"
        });
        return;
      }

      try {
        const answer = await answerQuestionWithImage({
          config: getProviderConfig(model.provider),
          modelId: model.id,
          imagePath: resolveUploadStorageKey(document.storageKey),
          mimeType: document.mimeType,
          question,
          systemPrompt: role.systemPrompt
        });

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
            strategy: "vision-model",
            topK: 0,
            totalChunks: 0,
            sources: [
              {
                sourceId: "image-0",
                chunkIndex: 0,
                similarity: 1,
                startChar: 0,
                endChar: 0,
                matchedTerms: [],
                contentPreview: `图片来源：${document.fileName}`
              }
            ]
          }
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "图片分析请求失败。";
        res.status(500).json({ error: message });
      }

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
      const ragDecision = await selectDocumentRagArchitecture(question, document);
      // 学习点：这里决定走 2-step、Agentic 还是 Hybrid RAG。
      // 为什么这样：简单问题默认最快，全文/知识库问题需要更强检索，多步骤任务交给 Agent。

      if (ragDecision.architecture === "agentic-rag") {
        // 学习点：Agentic RAG 不在这里手动拼 chunk，而是把“当前 thread 有附件”告诉 Agent。
        // 为什么这样：生成、对比、改写这类任务可能需要 Agent 自己决定是否调用文档工具。
        const agentProvider = new LangChainProvider(model.provider, getProviderConfig(model.provider));
        const agentPrompt = [
          question,
          "",
          `[Attachment available in current thread: ${document.fileName}]`,
          "Use the uploaded document tool when file content is needed. Do not expose raw chunk ids, scores, or internal retrieval metadata to the user."
        ].join("\n");
        const answer = await agentProvider.sendChat(
          model.id,
          agentPrompt,
          role.systemPrompt,
          role.fewShotExamples,
          model.provider === "openai" ? reasoningEffort : undefined,
          threadId,
          userId
        );

        saveDocumentQaExchange({
          threadId,
          userId,
          question,
          answer,
          attachmentName: document.fileName,
          attachmentFileId: document.fileId,
          sources: []
        });
        updateThreadAfterMessage({
          threadId,
          userId,
          providerId: model.provider,
          modelId: model.id,
          roleId: role.id,
          reasoningEffort: model.provider === "openai" ? reasoningEffort : undefined,
          userMessage: question
        });

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
            strategy: ragDecision.architecture,
            sourceScope: ragDecision.sourceScope,
            topK: 0,
            totalChunks: 0,
            sources: []
          }
        });
        return;
      }

      const twoStepRetrieval =
        ragDecision.architecture === "2-step-rag"
          ? await searchVectorDocumentIndex(document, question)
          : null;
      // 学习点：2-step 只做一次向量检索；非 2-step 就进入 Hybrid 检索。
      // 为什么这样：默认路径简单快速，只有复杂问题才付出 BM25、融合、重排、验证的成本。
      const hybridRetrieval = twoStepRetrieval
        ? null
        : await searchHybridDocumentIndex(document, question);
      const retrieval = twoStepRetrieval ?? hybridRetrieval;
      const isHybridRetrieval = Boolean(hybridRetrieval);

      if (!retrieval) {
        throw new Error("RAG retrieval did not return a result.");
      }

      const sources = retrieval.chunks.map((chunk) => ({
        sourceId: `chunk-${chunk.index}`,
        chunkIndex: chunk.index,
        similarity: hybridRetrieval ? chunk.hybridScore : chunk.similarity,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
        matchedTerms: chunk.matchedTerms,
        contentPreview: chunk.content
      }));
      const context = retrieval.chunks
        // 学习点：这里只把命中的片段放进 Prompt，不把整份文档塞给模型。
        // 为什么这样：避免上下文超限，也是 RAG 的核心价值。
        .map((chunk) =>
          [
            `[Source: chunk-${chunk.index}]`,
            hybridRetrieval
              ? `Hybrid score: ${chunk.hybridScore}`
              : `Vector similarity: ${chunk.similarity}`,
            `Vector similarity: ${chunk.similarity}`,
            `Keyword score: ${chunk.keywordScore}`,
            `BM25 score: ${chunk.bm25Score}`,
            `Rerank score: ${chunk.rerankScore}`,
            `Character range: ${chunk.startChar}-${chunk.endChar}`,
            hybridRetrieval?.validation.isWholeDocumentRequest
              ? chunk.content.slice(0, 520)
              : chunk.content
          ].join("\n")
        )
        .join("\n\n---\n\n");
      const qaPrompt = [
        // 学习点：这个 Prompt 是“用户问题 + 检索上下文 + RAG 策略说明”。
        // 为什么这样：模型只根据检索片段回答，降低胡说和超上下文风险。
        "Answer the user's question using the retrieved document context below.",
        `Selected RAG architecture: ${ragDecision.architecture}.`,
        `RAG source scope: ${ragDecision.sourceScope}.`,
        `Selection reason: ${ragDecision.reason}`,
        hybridRetrieval
          ? "Hybrid RAG is active: query enhancement, vector similarity, keyword matching, retrieval validation, and then generation."
          : "2-Step RAG is active: retrieve once, then generate a grounded answer.",
        hybridRetrieval?.validation.isWholeDocumentRequest
          ? "The user is asking for whole-document analysis. Use the representative chunks to provide an overall structure, key points, and reasonable limitations without claiming you saw every detail."
          : "The user is asking a focused question. Prioritize the highest scoring retrieved chunks.",
        !hybridRetrieval || hybridRetrieval.validation.isLikelySufficient
          ? "Answer directly and naturally."
          : "Retrieval validation is weak. Answer what can be supported, then ask one concise follow-up question to narrow the search.",
        "Do not show raw chunk ids, similarity scores, or a separate Sources line to the user.",
        "Write a natural, user-facing answer. Mention uncertainty only when the retrieved context is insufficient.",
        "",
        `Document: ${document.fileName}`,
        hybridRetrieval ? `Enhanced query: ${hybridRetrieval.enhancedQuery}` : "",
        hybridRetrieval
          ? `Retrieval validation: ${hybridRetrieval.validation.note}`
          : "Retrieval validation: skipped for 2-Step RAG.",
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
      // 2-step RAG 到这里就结束：一次检索 + 一次生成。
      // Answer Validation 属于当前项目的 Hybrid 质量控制步骤，只在 Hybrid 分支执行。
      const finalAnswer = hybridRetrieval
        ? await validateDocumentAnswer({
            provider,
            modelId: model.id,
            systemPrompt: role.systemPrompt,
            question,
            context,
            answer,
            threadId,
            userId,
            reasoningEffort: model.provider === "openai" ? reasoningEffort : undefined
          })
        : answer;

      saveDocumentQaExchange({
        threadId,
        userId,
        question,
        answer: finalAnswer,
        attachmentName: document.fileName,
        attachmentFileId: document.fileId,
        sources
      });
      updateThreadAfterMessage({
        threadId,
        userId,
        providerId: model.provider,
        modelId: model.id,
        roleId: role.id,
        reasoningEffort: model.provider === "openai" ? reasoningEffort : undefined,
        userMessage: question
      });

      res.json({
        answer: finalAnswer,
        document: {
          fileId: document.fileId,
          fileName: document.fileName,
          fileType: document.fileType,
          storageKey: document.storageKey,
          parseStatus: document.parseStatus,
          indexStatus: document.indexStatus
        },
        retrieval: {
          strategy: ragDecision.architecture,
          sourceScope: ragDecision.sourceScope,
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

app.post(
  "/api/knowledge-base/qa",
  async (
    req: Request<
      Record<string, string>,
      { error: string },
      {
        userId: string;
        threadId?: string;
        knowledgeBaseId?: string;
        modelId: string;
        roleId?: string;
        question: string;
        reasoningEffort?: ReasoningEffort;
      }
    >,
    res: Response
  ) => {
    // 学习点：这是“长期知识库问答”接口。
    // 为什么这样：它查询 data/knowledge-bases 已经索引的资料，不依赖用户本轮是否上传文件。
    const userId = req.body?.userId?.trim();
    const threadId = req.body?.threadId?.trim() || `${userId}:knowledge-base`;
    const knowledgeBaseId =
      req.body?.knowledgeBaseId?.trim() || "ai-agent-learning-manual";
    const modelId = req.body?.modelId?.trim();
    const roleId = req.body?.roleId?.trim() || appConfig.defaultRoleId;
    const question = req.body?.question?.trim();
    const reasoningEffort = req.body?.reasoningEffort;

    if (!userId || !modelId || !question) {
      res.status(400).json({
        error: "userId, modelId, and question are required."
      });
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
      // 步骤 1：跨知识库文档检索相关 chunk。
      // 当前知识库统一使用 Hybrid RAG，提高多版本、多文档场景的召回率。
      const retrieval = await searchKnowledgeBase(knowledgeBaseId, question);

      if (retrieval.chunks.length === 0) {
        res.status(404).json({
          error: "No relevant knowledge base content was found."
        });
        return;
      }

      const context = retrieval.chunks
        // 步骤 2：把不同文档命中的片段拼成上下文，并保留文件名/版本给模型参考。
        // 前端不显示原始 chunk 分数，避免影响用户体验。
        .map((chunk, index) =>
          [
            `[Knowledge document ${index + 1}]`,
            `File: ${chunk.fileName}`,
            chunk.version ? `Version: ${chunk.version}` : "",
            chunk.content
          ]
            .filter(Boolean)
            .join("\n")
        )
        .join("\n\n---\n\n");
      const qaPrompt = [
        // 步骤 3：把知识库上下文交给模型生成自然回答。
        // 注意：这里不是把整个知识库交给模型，而是只交给检索命中的片段。
        "Answer the user's question using the retrieved knowledge base context below.",
        `Knowledge base: ${knowledgeBaseId}`,
        `Selected RAG architecture: ${retrieval.architecture}.`,
        `Selection reason: ${retrieval.reason}`,
        "Write a natural, user-facing answer.",
        "Do not show raw chunk ids, similarity scores, BM25 scores, rerank scores, or a separate Sources line.",
        "When useful, mention the document version in natural language, such as v8 or v7.",
        "",
        "[Retrieved knowledge base context]",
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
        `${threadId}:knowledge-base-qa`,
        userId
      );

      res.json({
        answer,
        knowledgeBase: {
          id: knowledgeBaseId,
          documentCount: retrieval.documents.length
        },
        retrieval: {
          strategy: retrieval.architecture,
          topK: retrieval.chunks.length
        }
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Knowledge base QA request failed.";
      res.status(500).json({ error: message });
    }
  }
);

const chatHandler: RequestHandler = async (
  rawReq,
  res: Response<{ error: string }>
): Promise<void> => {
  // 学习点：这是普通聊天接口，也是前端发送按钮最终调用的入口。
  // 为什么这样：文本、角色、模型、附件、threadId 都在这里汇合，再交给 LangChain Agent。
  const req = rawReq as MulterRequest;
  const body = req.body as Partial<ChatRequestPayload>;
  const attachment = req.file;

  const userMessage = body?.message?.trim();
  const modelId = body?.modelId?.trim();
  const roleId = body?.roleId?.trim() || appConfig.defaultRoleId;
  const threadId = body?.threadId?.trim();
  const userId = body?.userId?.trim();
  const reasoningEffort = body?.reasoningEffort;
  const decodedAttachmentName = attachment
    ? decodeUploadedFileName(attachment.originalname)
    : "";
  const attachmentName = body?.attachmentName?.trim() || decodedAttachmentName;
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
      const originalName = decodeUploadedFileName(attachment.originalname);
      const storedUpload = await saveUploadFile({
        userId,
        threadId,
        originalName,
        buffer: attachment.buffer
      });
      const uploadedDocument = await createUploadedDocumentRecord({
        threadId,
        userId,
        fileId: storedUpload.fileId,
        fileName: originalName,
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
