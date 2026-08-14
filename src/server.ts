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
import fs from "fs";
import multer from "multer";
import path from "path";
import { createAuthToken, verifyAuthToken, verifyPassword } from "./auth";
import { appConfig, getProviderConfig } from "./config";
import { getUserById, getUserByUsername } from "./db/sqlite";
import { getModelById, getPublicModels } from "./modelRegistry";
import { getPromptRoleById, promptRoles } from "./prompts";
import { createProviderRegistry } from "./providerRegistry";
import { LangChainProvider } from "./providers/langChainProvider";
import { answerQuestionWithImage } from "./providers/visionQaProvider";
import { createUploadedDocumentRecord } from "./rag/documentChunkLab";
import {
  cleanupStalePendingUploads,
  commitPendingUploadFile,
  deletePendingUploadFile,
  deleteUploadThreadDirectory,
  deleteStoredUploadFile,
  resolveUploadStorageKey,
  savePendingUploadFile
} from "./rag/uploadFileStorage";
import {
  getUploadedDocument,
  getUploadedDocumentByFileId,
  saveUploadedDocument
} from "./rag/uploadedDocumentStore";
import { selectDocumentRagArchitecture } from "./rag/ragArchitectureRouter";
import { searchKnowledgeBase } from "./rag/knowledgeBaseRetriever";
import { searchGraphDocumentIndex } from "./rag/graphRag";
import {
  searchHybridDocumentIndex,
  searchVectorDocumentIndex
} from "./rag/vectorDocumentIndex";
import { clearVectorDocumentIndex } from "./rag/vectorDocumentIndex";
import {
  createThread,
  clearThreadContext,
  deleteThread,
  getThreadById,
  listThreadsByUser,
  renameThread,
  updateThreadAfterMessage
} from "./threads/threadRepository";
import type { ThreadMode } from "./threads/threadRepository";
import { listWorkspaceActivity } from "./workspace/workspaceActivityRepository";
import {
  listWorkspaceConflicts,
  listWorkspaceTurnConflicts,
  listWorkspaceTurnDiffs,
  resolveWorkspaceConflict,
  rollbackWorkspaceTurn
} from "./workspace/workspaceTurnSnapshotRepository";
import { listSubAgentRuns } from "./agents/subAgentRunRepository";
import { listTaskPlans } from "./agents/taskPlanRepository";
import {
  getAgentTurnObservability,
  recordAgentEvent
} from "./agents/agentTelemetryRepository";
import { getModelUsageSummary } from "./agents/modelUsageController";
import {
  listDocumentQaMessages,
  saveDocumentQaExchange
} from "./threads/documentQaHistoryRepository";
import {
  ChatProvider,
  ChatRequestPayload,
  PromptRole,
  ReasoningEffort,
  UsageProfile
} from "./types";
import type {
  PendingUploadFile,
  StoredUploadFile
} from "./rag/uploadFileStorage";
import {
  DEFAULT_WORKSPACE_ROOT,
  clearWorkThreadContextFiles,
  deleteWorkThreadStorage
} from "./workspace/localWorkStorage";
import {
  deleteGeneratedThreadDirectory,
  getGeneratedFile,
  listGeneratedFiles,
  resolveGeneratedFileStorageKey
} from "./files/generatedFileStore";
import type { UploadedDocumentRecord } from "./rag/uploadedDocumentStore";
import {
  closeMcpConnections,
  getMcpServerStatuses,
  initializeMcpTools,
  installMcpServer,
  type McpServerFileConfig
} from "./mcp/mcpManager";
import { installSkillFromPath } from "./skills/skillInstaller";
import { clearSkillRegistryCache, listAgentSkills } from "./skills/skillRegistry";
import { deleteThreadExtensions } from "./extensions/threadExtensionStorage";

type MulterRequest = Request & {
  file?: Express.Multer.File;
};

function decodeUploadedFileName(fileName: string): string {
  // Browser uploads may decode Chinese filenames as latin1, so try UTF-8 recovery.
  const decoded = Buffer.from(fileName, "latin1").toString("utf8");
  const countChinese = (value: string) =>
    [...value].filter((char) => /[\u4e00-\u9fff]/.test(char)).length;
  const hasMojibake = /[脙脗]|氓.|忙.|盲./.test(fileName);

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

app.get("/api/mcp/status", (_req, res) => {
  // 只返回连接状态和 Tool 名称，不返回 command、headers、环境变量或令牌。
  res.json({ servers: getMcpServerStatuses() });
});

app.get("/api/workspace/activity", (req, res) => {
  const threadId = String(req.query.threadId || "").trim();
  const userId = String(req.query.userId || "").trim();
  const thread = getThreadById(threadId, userId);
  if (!thread || thread.mode !== "work") {
    res.status(404).json({ error: "工作任务不存在。" });
    return;
  }
  res.json({
    activities: listWorkspaceActivity(threadId, userId),
    conflicts: listWorkspaceConflicts(threadId, userId)
  });
});

app.get("/api/workspace/diff", async (req, res) => {
  const threadId = String(req.query.threadId || "").trim();
  const userId = String(req.query.userId || "").trim();
  const turnId = String(req.query.turnId || "").trim();
  const thread = getThreadById(threadId, userId);
  if (!thread || thread.mode !== "work" || !turnId) {
    res.status(404).json({ error: "工作任务或修改轮次不存在。" });
    return;
  }
  try {
    res.json({
      diffs: await listWorkspaceTurnDiffs(threadId, userId, turnId),
      conflicts: listWorkspaceTurnConflicts(threadId, userId, turnId)
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "读取 Diff 失败。"
    });
  }
});

app.post("/api/workspace/rollback", express.json(), async (req, res) => {
  const threadId = String(req.body?.threadId || "").trim();
  const userId = String(req.body?.userId || "").trim();
  const turnId = String(req.body?.turnId || "").trim();
  const thread = getThreadById(threadId, userId);
  if (!thread || thread.mode !== "work" || !turnId) {
    res.status(404).json({ error: "工作任务或修改轮次不存在。" });
    return;
  }
  try {
    const restoredFiles = await rollbackWorkspaceTurn({
      threadId,
      userId,
      turnId
    });
    recordAgentEvent({
      threadId,
      userId,
      turnId,
      eventType: "workspace_rollback",
      status: "succeeded",
      metadata: { restoredFiles }
    });
    res.json({ restoredFiles });
  } catch (error) {
    recordAgentEvent({
      threadId,
      userId,
      turnId,
      eventType: "workspace_rollback",
      status: "conflicted",
      metadata: {
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      }
    });
    res.status(409).json({
      error: error instanceof Error ? error.message : "回退本轮失败。"
    });
  }
});

app.post("/api/workspace/conflicts/:conflictId/resolve", express.json(), (req, res) => {
  const conflictId = String(req.params.conflictId || "").trim();
  const threadId = String(req.body?.threadId || "").trim();
  const userId = String(req.body?.userId || "").trim();
  const thread = getThreadById(threadId, userId);
  if (!thread || thread.mode !== "work" || !conflictId) {
    res.status(404).json({ error: "工作任务或冲突记录不存在。" });
    return;
  }
  const resolved = resolveWorkspaceConflict({ threadId, userId, conflictId });
  if (!resolved) {
    res.status(409).json({ error: "冲突已经解决或不存在。" });
    return;
  }
  res.json({ resolved: true });
});

app.get("/api/subagents/runs", (req, res) => {
  const threadId = String(req.query.threadId || "").trim();
  const userId = String(req.query.userId || "").trim();
  if (!getThreadById(threadId, userId)) {
    res.status(404).json({ error: "对话不存在。" });
    return;
  }
  res.json({ runs: listSubAgentRuns(threadId, userId) });
});

app.get("/api/observability/turn", (req, res) => {
  const threadId = String(req.query.threadId || "").trim();
  const userId = String(req.query.userId || "").trim();
  const turnId = String(req.query.turnId || "").trim();
  if (!turnId || !getThreadById(threadId, userId)) {
    res.status(404).json({ error: "对话或任务轮次不存在。" });
    return;
  }
  res.json(getAgentTurnObservability(threadId, userId, turnId));
});

app.get("/api/observability/model-usage", (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId || !getUserById(userId)) {
    res.status(404).json({ error: "用户不存在。" });
    return;
  }
  res.json(getModelUsageSummary(userId));
});

app.get("/api/task-plans", (req, res) => {
  const threadId = String(req.query.threadId || "").trim();
  const userId = String(req.query.userId || "").trim();
  const thread = getThreadById(threadId, userId);
  if (!thread || thread.mode !== "work") {
    res.status(404).json({ error: "工作任务不存在。" });
    return;
  }
  res.json({ plans: listTaskPlans(threadId, userId) });
});

app.get("/api/generated-files", (req, res) => {
  const threadId = String(req.query.threadId || "").trim();
  const userId = String(req.query.userId || "").trim();
  const thread = getThreadById(threadId, userId);
  if (!thread) {
    res.status(404).json({ error: "对话不存在。" });
    return;
  }
  res.json({ files: listGeneratedFiles(threadId, userId) });
});

app.get("/api/generated-files/:fileId/download", (req, res) => {
  const fileId = String(req.params.fileId || "").trim();
  const userId = String(req.query.userId || "").trim();
  if (!fileId || !userId) {
    res.status(400).json({ error: "fileId and userId are required." });
    return;
  }
  const file = getGeneratedFile(fileId, userId);
  if (!file) {
    res.status(404).json({ error: "生成文件不存在。" });
    return;
  }
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`
  );
  res.sendFile(resolveGeneratedFileStorageKey(file.storageKey));
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

async function cleanupRejectedPendingUpload(
  pendingUpload: PendingUploadFile | undefined
): Promise<void> {
  // Pending files are not bound to a thread yet, so failed uploads must be removed from disk.
  await deletePendingUploadFile(pendingUpload);
}

async function cleanupRejectedCommittedUpload(
  storedUpload: StoredUploadFile | undefined
): Promise<void> {
  if (!storedUpload?.storageKey) {
    return;
  }

  // If SQLite writing fails after commit, delete the stored file to avoid orphan files.
  await deleteStoredUploadFile(storedUpload.storageKey);
}

function assertUploadCanBindToThread(
  document: UploadedDocumentRecord
): void {
  // Only usable files can be bound to the current thread; invalid files must not pollute RAG context.
  if (document.fileType === "image") {
    return;
  }

  if (document.parseStatus === "parsed" && document.text.trim()) {
    return;
  }

  if (document.parseStatus === "empty") {
    throw new Error(
      "文件已收到，但没有解析出可用于问答的文本内容，所以不会绑定到当前对话。"
    );
  }

  throw new Error(
    "当前文件类型暂不支持解析，所以不会绑定到当前对话。请上传 PDF、Markdown、TXT、Word、Excel、PPTX、HTML 或图片文件。"
  );
}

function getUploadFailureStatus(message: string): 400 | 500 {
  // File validation errors return 400; server parsing failures return 500.
  return message.includes("不会绑定到当前对话") ? 400 : 500;
}

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
  // Answer Validation checks whether the generated answer is grounded in retrieved context.
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

function requireExtensionUser(req: Request, res: Response): string | null {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const payload = verifyAuthToken(token, appConfig.auth.tokenSecret);
  if (!payload) {
    res.status(401).json({ error: "请先登录，再安装扩展。" });
    return null;
  }
  return payload.sub;
}

app.get("/api/extensions", (req, res) => {
  const userId = requireExtensionUser(req, res);
  if (!userId) return;
  const threadId = String(req.query.threadId || "").trim();
  if (!getThreadById(threadId, userId)) {
    res.status(404).json({ error: "当前对话不存在，无法读取扩展。" });
    return;
  }
  res.json({
    skills: listAgentSkills(threadId).map(({ name, description, source }) => ({
      name,
      description,
      source
    })),
    mcpServers: getMcpServerStatuses(threadId)
  });
});

app.post("/api/extensions/skills/install", (req, res) => {
  const userId = requireExtensionUser(req, res);
  if (!userId) return;
  try {
    const sourcePath = String(req.body?.sourcePath || "").trim();
    const threadId = String(req.body?.threadId || "").trim();
    if (!getThreadById(threadId, userId)) throw new Error("当前对话不存在，无法安装 Skill。");
    if (!sourcePath) throw new Error("没有选择 Skill 来源。");
    res.json({ skill: installSkillFromPath(sourcePath, threadId) });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Skill 安装失败。"
    });
  }
});

app.post("/api/extensions/mcp/install", async (req, res) => {
  const userId = requireExtensionUser(req, res);
  if (!userId) return;
  try {
    const threadId = String(req.body?.threadId || "").trim();
    if (!getThreadById(threadId, userId)) throw new Error("当前对话不存在，无法安装 MCP Server。");
    const name = String(req.body?.name || "").trim();
    const transport = req.body?.transport === "stdio" ? "stdio" : "http";
    const config: McpServerFileConfig = {
      enabled: true,
      transport,
      allowedModes: req.body?.allowChat ? ["chat", "work"] : ["work"],
      approval: ["always", "mutating", "never"].includes(req.body?.approval)
        ? req.body.approval
        : "always",
      ...(transport === "stdio"
        ? {
            command: String(req.body?.command || "").trim(),
            args: Array.isArray(req.body?.args)
              ? req.body.args.map(String)
              : []
          }
        : { url: String(req.body?.url || "").trim() })
    };
    const status = await installMcpServer(name, config, threadId);
    for (const provider of providers.values()) {
      if (provider instanceof LangChainProvider) provider.clearAgentCache();
    }
    res.json({ server: status });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "MCP Server 安装失败。"
    });
  }
});
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/auth/login", (req: Request, res: Response) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    res.status(400).json({ error: "请输入账号和密码。" });
    return;
  }

  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "账号或密码错误。" });
    return;
  }

  const publicUser = {
    id: user.id,
    username: user.username,
    displayName: user.displayName
  };
  const token = createAuthToken(
    publicUser,
    appConfig.auth.tokenSecret,
    appConfig.auth.tokenTtlSeconds
  );

  res.json({
    token,
    user: publicUser
  });
});

app.get("/api/auth/me", (req: Request, res: Response) => {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!token) {
    res.status(401).json({ error: "请先登录。" });
    return;
  }

  const payload = verifyAuthToken(token, appConfig.auth.tokenSecret);
  if (!payload) {
    res.status(401).json({ error: "登录已失效，请重新登录。" });
    return;
  }

  const user = getUserById(payload.sub);
  if (!user) {
    res.status(401).json({ error: "用户不存在，请重新登录。" });
    return;
  }

  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName
    }
  });
});

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
  const mode = String(req.query.mode || "chat").trim() as ThreadMode;
  const workspacePath = String(req.query.workspacePath || "").trim();
  if (!userId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }
  if (mode !== "chat" && mode !== "work") {
    res.status(400).json({ error: "mode must be chat or work." });
    return;
  }

  let resolvedWorkspacePath: string | undefined;
  if (mode === "work" && workspacePath) {
    try {
      resolvedWorkspacePath = fs.realpathSync.native(workspacePath);
    } catch {
      res.status(400).json({ error: "工作目录不存在或不可访问。" });
      return;
    }
  }

  res.json({
    threads: listThreadsByUser(userId, mode, resolvedWorkspacePath)
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
        mode?: ThreadMode;
        workspacePath?: string;
        workspaceName?: string;
      }
    >,
    res: Response
  ) => {
    const userId = req.body?.userId?.trim();
    const modelId = req.body?.modelId?.trim();
    const roleId = req.body?.roleId?.trim() || appConfig.defaultRoleId;
    const mode = req.body?.mode === "work" ? "work" : "chat";
    let workspacePath: string | undefined;
    let workspaceName: string | undefined;

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

    if (mode === "work") {
      const requestedWorkspacePath =
        req.body?.workspacePath?.trim() || DEFAULT_WORKSPACE_ROOT;
      try {
        workspacePath = fs.realpathSync.native(requestedWorkspacePath);
        if (!fs.statSync(workspacePath).isDirectory()) {
          throw new Error("not a directory");
        }
        workspaceName =
          req.body?.workspaceName?.trim() || path.basename(workspacePath);
      } catch {
        res.status(400).json({ error: "选择的工作目录不存在或不可访问。" });
        return;
      }
    }

    const thread = createThread({
      userId,
      providerId: model.provider,
      modelId: model.id,
      roleId: role.id,
      mode,
      workspacePath,
      workspaceName,
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
    const thread = getThreadById(threadId, userId);
    const deleted = deleteThread(threadId, userId);
    if (!deleted) {
      res.status(404).json({ error: "Thread was not found." });
      return;
    }

    if (thread?.mode === "work") {
      // 这里只删除 KimiBai 为任务创建的数据，绝不删除用户选择的工作目录。
      await deleteWorkThreadStorage(threadId);
    } else {
      await Promise.all([
        deleteUploadThreadDirectory({ userId, threadId }),
        deleteGeneratedThreadDirectory({ userId, threadId })
      ]);
    }
    await closeMcpConnections(threadId);
    deleteThreadExtensions(threadId);
    clearSkillRegistryCache(threadId);
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
    // Upload only saves the file and document record; analysis starts when the user asks in chat.
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

    let pendingUpload: PendingUploadFile | undefined;
    let committedUpload: StoredUploadFile | undefined;

    try {
      const originalName = decodeUploadedFileName(attachment.originalname);
      // Step 1: save original file into pending storage first.
      pendingUpload = await savePendingUploadFile({
        userId,
        threadId,
        originalName,
        buffer: attachment.buffer
      });

      // Step 2: parse file type and searchable text into an uploaded document record.
      const uploadedDocument = await createUploadedDocumentRecord({
        threadId,
        userId,
        fileId: pendingUpload.fileId,
        fileName: originalName,
        storageKey: pendingUpload.storageKey,
        mimeType: attachment.mimetype,
        fileSize: attachment.size,
        fileBuffer: attachment.buffer
      });

      // Step 3: validate before binding the file to current thread.
      assertUploadCanBindToThread(uploadedDocument);

      // Step 4: move the usable file from pending storage to final storage.
      committedUpload = await commitPendingUploadFile(pendingUpload);
      pendingUpload = undefined;

      // Step 5: persist document metadata in SQLite.
      saveUploadedDocument(uploadedDocument);
      committedUpload = undefined;

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
      await cleanupRejectedPendingUpload(pendingUpload);
      await cleanupRejectedCommittedUpload(committedUpload);
      const message =
        error instanceof Error ? error.message : "Failed to upload document.";
      res.status(getUploadFailureStatus(message)).json({ error: message });
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
        usageProfile?: UsageProfile;
      }
    >,
    res: Response
  ) => {
    // This endpoint answers questions about the document bound to the current thread.
    const userId = req.body?.userId?.trim();
    const threadId = req.body?.threadId?.trim();
    const modelId = req.body?.modelId?.trim();
    const roleId = req.body?.roleId?.trim() || appConfig.defaultRoleId;
    const question = req.body?.question?.trim();
    const reasoningEffort = req.body?.reasoningEffort;
    const usageProfile: UsageProfile =
      req.body?.usageProfile === "economy" || req.body?.usageProfile === "performance"
        ? req.body.usageProfile
        : "balanced";
    const wantsStream = req.headers.accept?.includes("text/event-stream") ?? false;
    const documentTaskController = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) {
        documentTaskController.abort();
      }
    });

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
      // Images require a vision-capable model; text RAG should not pretend it can read pixels.
      const sources = [
        {
          sourceId: "image-0",
          chunkIndex: 0,
          similarity: model.supportsVision ? 1 : 0,
          startChar: 0,
          endChar: 0,
          matchedTerms: [],
          contentPreview: `\u56fe\u7247\u6587\u4ef6\uff1a${document.fileName}`
        }
      ];

      try {
        const answer =
          model.supportsVision
            ? await answerQuestionWithImage({
                providerId: model.provider,
                config: getProviderConfig(model.provider),
                modelId: model.id,
                imagePath: resolveUploadStorageKey(document.storageKey),
                mimeType: document.mimeType,
                question,
                systemPrompt: role.systemPrompt,
                usageProfile
              })
            : "\u5f53\u524d\u6a21\u5f0f\u4e0d\u652f\u6301\u76f4\u63a5\u7406\u89e3\u56fe\u7247\u5185\u5bb9\uff0c\u6240\u4ee5\u65e0\u6cd5\u53ef\u9760\u5206\u6790\u8fd9\u5f20\u56fe\u7247\u3002\u8bf7\u5207\u6362\u5230\u652f\u6301\u56fe\u7247\u6216\u591a\u6a21\u6001\u7406\u89e3\u7684\u6a21\u5f0f\u540e\u518d\u4f7f\u7528\uff1b\u5982\u679c\u53ea\u9700\u8981\u6587\u7ae0\u4fee\u6539\u3001\u77e5\u8bc6\u95ee\u7b54\u6216\u666e\u901a\u6587\u672c\u5206\u6790\uff0c\u53ef\u4ee5\u7ee7\u7eed\u4f7f\u7528\u5f53\u524d\u6a21\u5f0f\u3002";
        const meta = {
          provider: model.provider,
          modelId: model.id,
          modelLabel: model.label,
          roleId: role.id,
          userId,
          threadId
        };

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

        if (wantsStream) {
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders();
          res.write(`data: ${JSON.stringify({ type: "meta", meta })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "delta", chunk: answer })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done", reply: answer, meta })}\n\n`);
          res.end();
          return;
        }

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
              model.supportsVision
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

    if (!document.text.trim()) {
      res.status(400).json({
        error:
          "The uploaded file was saved, but this file type has no extracted text for document QA yet."
      });
      return;
    }

    try {
      const ragDecision = await selectDocumentRagArchitecture(question, document);
      // 瀛︿範鐐癸細杩欓噷鍐冲畾璧?2-step銆丄gentic 杩樻槸 Hybrid RAG銆?      // 涓轰粈涔堣繖鏍凤細绠€鍗曢棶棰橀粯璁ゆ渶蹇紝鍏ㄦ枃/鐭ヨ瘑搴撻棶棰橀渶瑕佹洿寮烘绱紝澶氭楠や换鍔′氦缁?Agent銆?
      if (ragDecision.architecture === "agentic-rag") {
        // Agentic RAG lets the LangChain agent decide whether to call document tools.
        const agentProvider = new LangChainProvider(model.provider, getProviderConfig(model.provider));
        const agentPrompt = [
          question,
          "",
          `[Attachment available in current thread: ${document.fileName}]`,
          "Use the uploaded document tool when file content is needed. Do not expose raw chunk ids, scores, or internal retrieval metadata to the user."
        ].join("\n");
        const meta = {
          provider: model.provider,
          modelId: model.id,
          modelLabel: model.label,
          roleId: role.id,
          userId,
          threadId
        };
        let answer = "";
        if (wantsStream) {
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders();
          res.write(`data: ${JSON.stringify({ type: "meta", meta })}\n\n`);
          answer = await agentProvider.streamChat(
            model.id,
            agentPrompt,
            role.systemPrompt,
            (chunk) => {
              res.write(`data: ${JSON.stringify({ type: "delta", chunk })}\n\n`);
            },
            role.fewShotExamples,
            model.provider === "openai" ? reasoningEffort : undefined,
            threadId,
            userId,
            documentTaskController.signal,
            undefined,
            undefined,
            usageProfile
          );
        } else {
          answer = await agentProvider.sendChat(
            model.id,
            agentPrompt,
            role.systemPrompt,
            role.fewShotExamples,
            model.provider === "openai" ? reasoningEffort : undefined,
            threadId,
            userId,
            undefined,
            usageProfile
          );
        }

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

        if (wantsStream) {
          res.write(`data: ${JSON.stringify({ type: "done", reply: answer, meta })}\n\n`);
          res.end();
          return;
        }

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
      const graphRetrieval =
        ragDecision.architecture === "graph-rag"
          ? await searchGraphDocumentIndex(document, question)
          : null;
      const hybridRetrieval = twoStepRetrieval || graphRetrieval
        ? null
        : await searchHybridDocumentIndex(document, question);
      const retrieval = twoStepRetrieval ?? graphRetrieval ?? hybridRetrieval;
      const isHybridRetrieval = Boolean(hybridRetrieval);
      const isGraphRetrieval = Boolean(graphRetrieval);
      if (!retrieval) {
        throw new Error("RAG retrieval did not return a result.");
      }

      const sources = retrieval.chunks.map((chunk) => ({
        sourceId: `chunk-${chunk.index}`,
        chunkIndex: chunk.index,
        similarity: hybridRetrieval || graphRetrieval ? chunk.hybridScore : chunk.similarity,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
        sourceType: chunk.sourceType,
        pageNumber: chunk.pageNumber,
        blockIndex: chunk.blockIndex,
        locator: chunk.locator,
        matchedTerms: chunk.matchedTerms,
        contentPreview: chunk.content
      }));
      const context = retrieval.chunks
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
            `Locator: ${chunk.locator}`,
            hybridRetrieval?.validation.isWholeDocumentRequest
              ? chunk.content.slice(0, 520)
              : chunk.content
          ].join("\n")
        )
        .join("\n\n---\n\n");
      const qaPrompt = [
        "Answer the user's question using the retrieved document context below.",
        hybridRetrieval
          ? "Hybrid RAG is active: query enhancement, vector similarity, keyword matching, retrieval validation, and then generation."
          : isGraphRetrieval
            ? "GraphRAG is active: retrieve relevant chunks, expand through document entity relationships, then generate a grounded answer."
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
        graphRetrieval
          ? `GraphRAG search mode: ${graphRetrieval.graph.searchMode}.`
          : "",
        graphRetrieval
          ? `Graph expansion: matched entities ${graphRetrieval.graph.matchedEntities.join(", ") || "none"}; expanded entities ${graphRetrieval.graph.expandedEntities.join(", ") || "none"}.`
          : "",
        graphRetrieval?.graph.generatedQuestions.length
          ? `Question Generation suggestions: ${graphRetrieval.graph.generatedQuestions.join(" | ")}.`
          : "",
        hybridRetrieval
          ? `Retrieval validation: ${hybridRetrieval.validation.note}`
          : graphRetrieval
            ? `Retrieval validation: ${graphRetrieval.validation.note}`
            : "Retrieval validation: skipped for 2-Step RAG.",
        "",
        "[Retrieved document context]",
        context,
        "",
        "[Question]",
        question
      ].join("\n");
      const meta = {
        provider: model.provider,
        modelId: model.id,
        modelLabel: model.label,
        roleId: role.id,
        userId,
        threadId
      };
      let answer = "";
      if (wantsStream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: "meta", meta })}\n\n`);
        answer = await provider.streamChat(
          model.id,
          qaPrompt,
          role.systemPrompt,
          (chunk) => {
            res.write(`data: ${JSON.stringify({ type: "delta", chunk })}\n\n`);
          },
          role.fewShotExamples,
          model.provider === "openai" ? reasoningEffort : undefined,
          `${threadId}:document-qa`,
          userId,
          documentTaskController.signal,
          undefined,
          undefined,
          usageProfile
        );
      } else {
        answer = await provider.sendChat(
          model.id,
          qaPrompt,
          role.systemPrompt,
          role.fewShotExamples,
          model.provider === "openai" ? reasoningEffort : undefined,
          `${threadId}:document-qa`,
          userId,
          undefined,
          usageProfile
        );
      }
      // 2-Step 只做一次检索和一次生成；Hybrid / GraphRAG 会额外做答案校验。
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
        : graphRetrieval
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

      if (wantsStream) {
        res.write(`data: ${JSON.stringify({ type: "done", reply: finalAnswer, meta })}\n\n`);
        res.end();
        return;
      }

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
      if (wantsStream && res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
        res.end();
        return;
      }
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
    // Knowledge-base QA searches indexed long-term materials, not only the current upload.
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
      // Step 1: retrieve relevant chunks across indexed knowledge-base documents.
      const retrieval = await searchKnowledgeBase(knowledgeBaseId, question);

      if (retrieval.chunks.length === 0) {
        res.status(404).json({
          error: "No relevant knowledge base content was found."
        });
        return;
      }

      const context = retrieval.chunks
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
        "Answer the user's question using the retrieved knowledge base context below.",
        `Selected RAG architecture: ${retrieval.architecture}.`,
        `RAG source scope: ${retrieval.sourceScope}.`,
        `Selection reason: ${retrieval.reason}`,
        retrieval.graph
          ? `GraphRAG search mode: ${retrieval.graph.searchMode}.`
          : "",
        retrieval.graph
          ? `Graph expansion: matched entities ${retrieval.graph.matchedEntities.join(", ") || "none"}; expanded entities ${retrieval.graph.expandedEntities.join(", ") || "none"}.`
          : "",
        retrieval.graph?.generatedQuestions.length
          ? `Question Generation suggestions: ${retrieval.graph.generatedQuestions.join(" | ")}.`
          : "",
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
  // Main chat endpoint: text, role, model, attachment, and threadId meet here.
  const req = rawReq as MulterRequest;
  const body = req.body as Partial<ChatRequestPayload>;
  const attachment = req.file;

  const userMessage = body?.message?.trim();
  const modelId = body?.modelId?.trim();
  const roleId = body?.roleId?.trim() || appConfig.defaultRoleId;
  const threadId = body?.threadId?.trim();
  const userId = body?.userId?.trim();
  const turnId = body?.turnId?.trim();
  const reasoningEffort = body?.reasoningEffort;
  const usageProfile: UsageProfile =
    body?.usageProfile === "economy" || body?.usageProfile === "performance"
      ? body.usageProfile
      : "balanced";
  const decodedAttachmentName = attachment
    ? decodeUploadedFileName(attachment.originalname)
    : "";
  const attachmentName = body?.attachmentName?.trim() || decodedAttachmentName;
  const effectiveUserMessage =
    userMessage ||
    (attachmentName ? `I uploaded a file named ${attachmentName}.` : "");
  const isApprovalControlMessage = effectiveUserMessage.startsWith(
    "__HITL_DECISIONS__:"
  );

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

  let pendingUpload: PendingUploadFile | undefined;
  let committedUpload: StoredUploadFile | undefined;

  try {
    /**
     * If the user attached a document to this message, we parse it once here and
     * bind it to the current thread. The model may later decide whether to use the
     * uploaded-document tool based on the user's intent.
     */
    if (attachment) {
      const originalName = decodeUploadedFileName(attachment.originalname);
      pendingUpload = await savePendingUploadFile({
        userId,
        threadId,
        originalName,
        buffer: attachment.buffer
      });
      const uploadedDocument = await createUploadedDocumentRecord({
        threadId,
        userId,
        fileId: pendingUpload.fileId,
        fileName: originalName,
        storageKey: pendingUpload.storageKey,
        mimeType: attachment.mimetype,
        fileSize: attachment.size,
        fileBuffer: attachment.buffer
      });
      // Validate attachment before writing it into the current thread context.
      assertUploadCanBindToThread(uploadedDocument);
      committedUpload = await commitPendingUploadFile(pendingUpload);
      pendingUpload = undefined;
      saveUploadedDocument(uploadedDocument);
      committedUpload = undefined;
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
     * 鎶娾€滄湰杞‘瀹炲甫浜嗛檮浠垛€濇樉寮忓啓杩涘彂缁欐ā鍨嬬殑鐢ㄦ埛娑堟伅閲屻€?     * 杩欐牱妯″瀷鍦ㄥ綋鍓嶅洖鍚堝氨鑳芥劅鐭ラ檮浠跺瓨鍦紝鑰屼笉鏄彧渚濊禆涓棿浠堕噷鐨勯€氱敤鑳屾櫙鎻愮ず銆?     */
    const messageForModel = attachmentName
      ? [
          effectiveUserMessage,
          "",
          `[Attachment available in current thread: ${attachmentName}]`,
          "If the user asks to use the file content, call retrieve_uploaded_document_chunks to retrieve only relevant chunks before answering."
        ].join("\n")
      : effectiveUserMessage;

    // 浏览器断开连接或主动停止时，中止 LangGraph 本轮执行。
    const taskController = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) {
        taskController.abort();
      }
    });

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
      userId,
      taskController.signal,
      turnId,
      (progress) => {
        res.write(`data: ${JSON.stringify({ type: "status", ...progress })}\n\n`);
      },
      usageProfile
    );

    // 审批决定是控制信号，不是用户对话内容，不能污染标题和消息预览。
    if (!isApprovalControlMessage) {
      updateThreadAfterMessage({
        threadId,
        userId,
        providerId: model.provider,
        modelId: model.id,
        roleId: role.id,
        reasoningEffort: model.provider === "openai" ? reasoningEffort : undefined,
        userMessage: effectiveUserMessage
      });
    }

    res.write(`data: ${JSON.stringify({ type: "done", reply, meta })}\n\n`);
    res.end();
  } catch (error) {
    await cleanupRejectedPendingUpload(pendingUpload);
    await cleanupRejectedCommittedUpload(committedUpload);
    const message =
      error instanceof Error ? error.message : "Unknown error while requesting the model.";

    if (!res.headersSent) {
      res.status(getUploadFailureStatus(message)).json({ error: message });
      return;
    }

    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    res.end();
  }
};

app.post("/api/chat", maybeChatUpload, chatHandler);

async function startServer(): Promise<void> {
  // MCP 必须先完成 Tool Discovery，再创建任何缓存 Agent。
  await initializeMcpTools();
  app.listen(appConfig.port, appConfig.host, () => {
    console.log(`Chat Demo is running at http://${appConfig.host}:${appConfig.port}`);
    void cleanupStalePendingUploads()
      .then((deletedCount) => {
        if (deletedCount > 0) {
          console.log(`Cleaned ${deletedCount} stale pending upload file(s).`);
        }
      })
      .catch((error) => {
        console.warn("Failed to clean stale pending upload files:", error);
      });
  });
}

process.once("SIGINT", () => {
  void closeMcpConnections().finally(() => process.exit(0));
});

app.post("/api/threads/:threadId/clear-context", async (req: Request, res: Response) => {
  const userId = String(req.query.userId || "").trim();
  const threadId = String(req.params.threadId || "").trim();
  if (!userId || !threadId) {
    res.status(400).json({ error: "userId and threadId are required." });
    return;
  }

  try {
    const existing = getThreadById(threadId, userId);
    if (!existing) {
      res.status(404).json({ error: "当前对话不存在。" });
      return;
    }
    clearVectorDocumentIndex(threadId);
    if (existing.mode === "work") {
      await clearWorkThreadContextFiles(threadId);
    } else {
      await deleteUploadThreadDirectory({ userId, threadId });
    }
    const thread = clearThreadContext(threadId, userId);
    for (const provider of providers.values()) {
      if (provider instanceof LangChainProvider) provider.clearAgentCache();
    }
    res.json({ ok: true, thread });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "清除上下文失败。"
    });
  }
});
process.once("SIGTERM", () => {
  void closeMcpConnections().finally(() => process.exit(0));
});

void startServer().catch((error) => {
  console.error("服务启动失败：", error);
  process.exitCode = 1;
});
