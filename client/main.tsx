import React, {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";

type ProviderId = "deepseek" | "openai" | "siliconflow" | "moonshot";
type ReasoningEffort = "minimal" | "low" | "medium" | "high";

type ModelOption = {
  id: string;
  label: string;
  provider: ProviderId;
  description: string;
  enabled: boolean;
  unavailableReason?: string;
};

type PromptRole = {
  id: string;
  label: string;
  summary: string;
};

type AuthSession = {
  token: string;
  user: {
    id: string;
    username: string;
    displayName: string;
  };
};

type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  turnId?: string;
  completed?: boolean;
  startedAt?: number;
  elapsedMs?: number;
  statusMessage?: string;
  stopped?: boolean;
  meta?: string;
  attachmentName?: string;
  attachmentFileId?: string;
  attachmentPreviewUrl?: string;
  sources?: DocumentSource[];
};

type DocumentSource = {
  sourceId: string;
  chunkIndex: number;
  similarity: number;
  startChar: number;
  endChar: number;
  matchedTerms: string[];
  contentPreview: string;
};

type DocumentUploadResult = {
  document: {
    fileId: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    storageKey: string;
    parseStatus: string;
    indexStatus: string;
  };
};

type DocumentQaResult = {
  answer: string;
  document: {
    fileId: string;
    fileName: string;
    fileType: string;
    storageKey: string;
    parseStatus: string;
    indexStatus: string;
  };
  retrieval: {
    strategy: string;
    topK: number;
    totalChunks: number;
    sources: DocumentSource[];
  };
};

type ChatThread = {
  threadId: string;
  userId: string;
  providerId: ProviderId;
  modelId: string;
  roleId: string;
  reasoningEffort?: ReasoningEffort;
  mode: "chat" | "work";
  workspacePath?: string;
  workspaceName?: string;
  title: string;
  lastMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
};

type StreamMeta = {
  provider: ProviderId;
  modelId: string;
  modelLabel: string;
  roleId: string;
  userId: string;
  threadId: string;
};

type StreamEvent =
  | { type: "meta"; meta: StreamMeta }
  | {
      type: "status";
      stage: "thinking" | "editing_file" | "running_command" | "finalizing";
      message: string;
    }
  | { type: "delta"; chunk: string }
  | { type: "done"; reply: string; meta: StreamMeta }
  | { type: "error"; error: string };

type ApprovalDecision = "approve" | "reject";

type ApprovalItem = {
  index: number;
  toolName: string;
  description: string;
};

function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

type DesktopWorkspace = {
  name: string;
  path: string;
  branch: string;
  selectedAt: string;
};

type WorkspaceActivity = {
  activityId: string;
  activityType: "file_write" | "command";
  turnId?: string;
  filePath?: string;
  additions?: number;
  deletions?: number;
  commandText?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  createdAt: string;
};

declare global {
  interface Window {
    desktopAPI?: {
      platform: string;
      selectWorkspace: (userId: string) => Promise<DesktopWorkspace | null>;
      getWorkspace: (userId: string) => Promise<DesktopWorkspace | null>;
      clearWorkspace: (userId: string) => Promise<void>;
      revealWorkspace: (workspacePath: string) => Promise<void>;
    };
  }
}

async function readJsonResponse(response: Response, apiName: string) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${apiName} returned non-JSON content. Please restart the backend with the latest code.`
    );
  }
}

function applyStreamEvent(rawEvent: string, onEvent: (event: StreamEvent) => void) {
  const lines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (const line of lines) {
    onEvent(JSON.parse(line) as StreamEvent);
  }
}

function getOrCreateStoredId(storageKey: string): string {
  const existingValue = localStorage.getItem(storageKey);
  if (existingValue) {
    return existingValue;
  }

  const nextValue = crypto.randomUUID();
  localStorage.setItem(storageKey, nextValue);
  return nextValue;
}

const AUTH_SESSION_STORAGE_KEY = "chat-demo-auth-session";

function getStoredAuthSession(): AuthSession | null {
  const rawSession = localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
  if (!rawSession) {
    return null;
  }

  try {
    const session = JSON.parse(rawSession) as AuthSession;
    if (!session.token || !session.user?.id) {
      localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
      return null;
    }

    return session;
  } catch {
    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    return null;
  }
}

function getInitialUserId(): string {
  return getStoredAuthSession()?.user.id || getOrCreateStoredId("chat-demo-user-id");
}

const AUTO_SCROLL_THRESHOLD = 120;
const THINKING_STATUS_TEXT = "正在思考…";
const DOCUMENT_QA_STATUS_TEXT = "正在检索文档…";
const APPROVED_ACTION_STATUS_TEXT = "正在执行已批准的操作…";
const APPROVAL_PROMPT_PREFIX = "需要你的确认：";
const PENDING_STATUS_TEXTS = new Set([
  THINKING_STATUS_TEXT,
  DOCUMENT_QA_STATUS_TEXT,
  APPROVED_ACTION_STATUS_TEXT
]);
const ATTACHMENT_MARKER_PATTERN =
  /\n*\[Attachment available in current thread: ([^\]]+)\]\n(?:If the user wants analysis, extraction, chunking, summarization, or document QA, call inspect_uploaded_document\.|If the user asks to use the file content, call chunk_uploaded_document to split it into bounded chunks before answering\.|If the user asks to use the file content, call retrieve_uploaded_document_chunks to retrieve only relevant chunks before answering\.)/;

function parseApprovalItems(request: string): ApprovalItem[] {
  const matches = [...request.matchAll(/^(\d+)\.\s+\[([^\]]+)\]\s+(.+)$/gm)];
  if (matches.length) {
    return matches.map((match, index) => ({
      index,
      toolName: match[2].trim(),
      description: match[3].trim()
    }));
  }

  // 兼容升级前已经保存在 SQLite 中的单项审批提示。
  const description = request
    .replace(APPROVAL_PROMPT_PREFIX, "")
    .replace(/请(?:回复|选择)[\s\S]*$/, "")
    .trim();
  return description
    ? [{ index: 0, toolName: "待执行操作", description }]
    : [];
}

function extractAttachmentFromContent(content: string): {
  content: string;
  attachmentName?: string;
} {
  const match = content.match(ATTACHMENT_MARKER_PATTERN);
  if (!match) {
    return { content };
  }

  return {
    content: content.replace(ATTACHMENT_MARKER_PATTERN, "").trim(),
    attachmentName: match[1]
  };
}

function isImageFile(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(extension);
}

function normalizeFileName(fileName: string): string {
  if (!fileName) {
    return fileName;
  }

  const hasMojibake = /[\u00c3\u00c2]|\u00e5.|\u00e6.|\u00e4./.test(fileName);
  if (!hasMojibake) {
    return fileName;
  }

  try {
    const bytes = Uint8Array.from([...fileName].map((char) => char.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const chineseCount = (value: string) =>
      [...value].filter((char) => /[\u4e00-\u9fff]/.test(char)).length;
    return chineseCount(decoded) >= chineseCount(fileName) ? decoded : fileName;
  } catch {
    return fileName;
  }
}

function getAttachmentKind(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() || "";

  if (isImageFile(fileName)) {
    return "图片";
  }

  if (extension === "pptx") {
    return "PPT";
  }

  if (extension === "docx") {
    return "Word";
  }

  if (["xlsx", "xls", "csv"].includes(extension)) {
    return "表格";
  }

  if (["html", "htm"].includes(extension)) {
    return "网页";
  }

  if (extension === "pdf") {
    return "PDF";
  }

  return extension ? extension.toUpperCase() : "文件";
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }

    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function isMarkdownTable(lines: string[], index: number): boolean {
  return (
    index + 1 < lines.length &&
    lines[index].trim().startsWith("|") &&
    lines[index + 1].trim().startsWith("|") &&
    /^(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1].trim())
  );
}

function renderMarkdown(content: string): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  const lines = content.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre className="markdown-code-block" key={`code-${index}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (isMarkdownTable(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      const rows = tableLines
        .filter((_, rowIndex) => rowIndex !== 1)
        .map((row) =>
          row
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim())
        );
      const [header, ...bodyRows] = rows;
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInlineMarkdown(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInlineMarkdown(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const Tag = `h${headingMatch[1].length}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(<Tag key={`heading-${index}`}>{renderInlineMarkdown(headingMatch[2])}</Tag>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !lines[index].match(/^(#{1,4})\s+/) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !isMarkdownTable(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {renderInlineMarkdown(paragraphLines.join("\n"))}
      </p>
    );
  }

  return blocks;
}

function App() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [roles, setRoles] = useState<PromptRole[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState("");
  const [modelId, setModelId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("low");
  const [message, setMessage] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progressClock, setProgressClock] = useState(() => Date.now());
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState("");
  const [renamingTitle, setRenamingTitle] = useState("");
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authSession, setAuthSession] = useState<AuthSession | null>(() =>
    getStoredAuthSession()
  );
  const [userId, setUserId] = useState(() => getInitialUserId());
  const [appMode, setAppMode] = useState<"chat" | "work">("chat");
  const [workspace, setWorkspace] = useState<DesktopWorkspace | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false);
  const [workspaceActivities, setWorkspaceActivities] = useState<WorkspaceActivity[]>([]);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [loginName, setLoginName] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("admin123");
  const [loginError, setLoginError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<string | null>(null);
  const [approvalTurnId, setApprovalTurnId] = useState("");
  const [approvalDecisions, setApprovalDecisions] = useState<
    Record<number, ApprovalDecision>
  >({});
  const [attachment, setAttachment] = useState<File | null>(null);
  const [composerAttachmentPreviewUrl, setComposerAttachmentPreviewUrl] = useState("");
  const [activeDocumentName, setActiveDocumentName] = useState("");
  const chatLayoutRef = useRef<HTMLElement | null>(null);
  const composerShellRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeRequestControllerRef = useRef<AbortController | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const pendingInitialScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    if (!isSubmitting) {
      return;
    }

    const timer = window.setInterval(() => setProgressClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isSubmitting]);

  useLayoutEffect(() => {
    // 固定输入框不参与文档流，消息区必须按它的实际高度预留空间。
    // ResizeObserver 同时覆盖附件预览、窗口缩放和 textarea 变高的情况。
    const composer = composerShellRef.current;
    const layout = chatLayoutRef.current;
    if (!composer || !layout) {
      return;
    }

    const updateComposerHeight = () => {
      layout.style.setProperty(
        "--composer-height",
        `${Math.ceil(composer.getBoundingClientRect().height)}px`
      );
    };
    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(composer);
    updateComposerHeight();
    return () => observer.disconnect();
  }, [appMode, entries.length, attachment]);

  useLayoutEffect(() => {
    // 学习点：只有用户接近底部时，AI 新内容才自动滚到底部。
    // 如果用户正在往上看历史，就保持当前位置，不强制打断。
    if (!shouldAutoScrollRef.current && !pendingInitialScrollRef.current) {
      return;
    }

    const behavior = pendingInitialScrollRef.current ? "auto" : "smooth";
    const scrollToBottom = () => {
      const container = chatLayoutRef.current;
      const composerHeight = composerShellRef.current?.offsetHeight ?? 0;
      if (container) {
        container.scrollTo({
          top: container.scrollHeight - container.clientHeight + composerHeight,
          behavior
        });
        lastScrollTopRef.current = container.scrollTop;
      }
      pendingInitialScrollRef.current = false;
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(scrollToBottom);
    });
  }, [entries, isSubmitting, activeThreadId]);

  useEffect(() => {
    // 刷新页面后，LangGraph 会从 SQLite 恢复暂停状态。
    // 如果历史中最后一条助手消息是审批请求，就重新打开审批弹窗。
    const latestAssistantEntry = [...entries]
      .reverse()
      .find((entry) => entry.role === "assistant");
    const pendingApproval =
      latestAssistantEntry?.content.startsWith(APPROVAL_PROMPT_PREFIX)
        ? latestAssistantEntry.content
        : null;
    setApprovalRequest(pendingApproval);
    setApprovalTurnId(pendingApproval ? latestAssistantEntry?.turnId || "" : "");
  }, [entries]);

  useEffect(() => {
    let cancelled = false;
    if (!window.desktopAPI || !userId.trim()) {
      setWorkspace(null);
      return;
    }

    setIsWorkspaceLoading(true);
    window.desktopAPI
      .getWorkspace(userId.trim())
      .then((storedWorkspace) => {
        if (!cancelled) {
          setWorkspace(storedWorkspace);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setWorkspaceError(
            loadError instanceof Error ? loadError.message : "读取工作目录失败。"
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsWorkspaceLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (isLoading || !userId.trim() || !modelId || !roleId) {
      return;
    }

    // Chat 与 Work 使用完全独立的 thread 列表和当前会话。
    void loadThreads(
      userId.trim(),
      modelId,
      roleId,
      reasoningEffort,
      appMode,
      workspace
    ).catch((modeError) => {
      setError(
        modeError instanceof Error ? modeError.message : "切换对话模式失败。"
      );
    });
  }, [appMode]);

  useEffect(() => {
    if (appMode !== "work" || !activeThreadId || !userId.trim()) {
      setWorkspaceActivities([]);
      return;
    }
    void loadWorkspaceActivities();
  }, [appMode, activeThreadId, userId]);

  const approvalItems = useMemo(
    () => (approvalRequest ? parseApprovalItems(approvalRequest) : []),
    [approvalRequest]
  );
  useEffect(() => {
    // 每次出现一批新的审批项时清空旧选择，避免把上一批决定误用到下一批。
    setApprovalDecisions({});
  }, [approvalRequest]);

  const currentModel = useMemo(
    () => models.find((item) => item.id === modelId),
    [models, modelId]
  );
  const currentRole = useMemo(
    () => roles.find((item) => item.id === roleId),
    [roles, roleId]
  );
  const legacyActivityByEntryId = useMemo(() => {
    // 旧版本没有 turnId。按执行时间把相邻写入视为同一轮，再从后向前绑定助手结果。
    // 新记录都有 turnId，不进入这段兼容逻辑。
    const legacyActivities = workspaceActivities
      .filter(
        (activity) =>
          !activity.turnId &&
          activity.activityType === "file_write" &&
          activity.filePath
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const groups: WorkspaceActivity[][] = [];
    const LEGACY_TURN_GAP_MS = 90_000;
    for (const activity of legacyActivities) {
      const latestGroup = groups.at(-1);
      const previousActivity = latestGroup?.at(-1);
      if (
        !latestGroup ||
        !previousActivity ||
        new Date(activity.createdAt).getTime() -
          new Date(previousActivity.createdAt).getTime() >
          LEGACY_TURN_GAP_MS
      ) {
        groups.push([activity]);
      } else {
        latestGroup.push(activity);
      }
    }

    // 第一条带 turnId 的用户消息标志着新版精确关联开始。
    // 旧活动只能绑定到它之前的历史回复，绝不能漂移到后续批准或拒绝轮次。
    const firstPreciseTurnIndex = entries.findIndex(
      (entry) => entry.role === "user" && Boolean(entry.turnId)
    );
    const legacyEntries =
      firstPreciseTurnIndex >= 0
        ? entries.slice(0, firstPreciseTurnIndex)
        : entries;
    const assistantEntries = legacyEntries.filter(
      (entry) => entry.role === "assistant"
    );
    const targetEntries = assistantEntries.slice(-groups.length);
    return new Map(
      targetEntries.map((entry, index) => [entry.id, groups[index] || []])
    );
  }, [entries, workspaceActivities]);
  const isEmptyThread = !isLoading && !isThreadLoading && entries.length === 0;
  const canSubmit = Boolean(
    !isSubmitting &&
      !isLoading &&
      !isThreadLoading &&
      activeThreadId &&
      modelId &&
      roleId &&
      (appMode === "chat" || workspace) &&
      (message.trim() || attachment)
  );

  useEffect(() => {
    const session = getStoredAuthSession();
    if (!session) {
      return;
    }

    let isCancelled = false;

    async function validateStoredSession() {
      try {
        const response = await fetch("/api/auth/me", {
          headers: {
            Authorization: `Bearer ${session.token}`
          }
        });

        if (!response.ok) {
          throw new Error("Session expired");
        }

        const data = (await response.json()) as { user: AuthSession["user"] };
        if (isCancelled) {
          return;
        }

        const nextSession: AuthSession = {
          token: session.token,
          user: data.user
        };
        localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(nextSession));
        localStorage.setItem("chat-demo-user-id", data.user.id);
        setAuthSession(nextSession);
        setUserId(data.user.id);
      } catch {
        if (isCancelled) {
          return;
        }

        const guestUserId = crypto.randomUUID();
        localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
        localStorage.setItem("chat-demo-user-id", guestUserId);
        sessionStorage.removeItem("chat-demo-active-thread-id");
        setAuthSession(null);
        setUserId(guestUserId);
        setEntries([]);
        setActiveThreadId("");
        setThreads([]);
        setError("登录已失效，请重新登录。");
      }
    }

    void validateStoredSession();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!attachment || !isImageFile(attachment.name)) {
      setComposerAttachmentPreviewUrl("");
      return;
    }

    const previewUrl = URL.createObjectURL(attachment);
    setComposerAttachmentPreviewUrl(previewUrl);

    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [attachment]);

  useEffect(() => {
    async function bootstrap() {
      // 学习点：页面启动时先加载模型和角色，后面发送消息时会一起提交给后端。
      try {
        const [modelsResponse, rolesResponse] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/roles")
        ]);

        const modelsData = await readJsonResponse(modelsResponse, "/api/models");
        const rolesData = await readJsonResponse(rolesResponse, "/api/roles");

        if (!modelsResponse.ok) {
          throw new Error(modelsData.error || "加载模型失败。");
        }

        if (!rolesResponse.ok) {
          throw new Error(rolesData.error || "加载角色失败。");
        }

        const enabledModels = (modelsData.models || []).filter(
          (item: ModelOption) => item.enabled
        );
        const availableRoles = rolesData.roles || [];
        const nextModelId = enabledModels[0]?.id || "";
        const nextRoleId = availableRoles.some(
          (item: PromptRole) => item.id === rolesData.defaultRoleId
        )
          ? rolesData.defaultRoleId
          : availableRoles[0]?.id || "";

        setModels(enabledModels);
        setRoles(availableRoles);
        setModelId(nextModelId);
        setRoleId(nextRoleId);

        if (userId.trim() && nextModelId && nextRoleId) {
          await loadThreads(userId.trim(), nextModelId, nextRoleId, "low", "chat");
        }
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : "初始化失败。"
        );
      } finally {
        setIsLoading(false);
      }
    }

    void bootstrap();
  }, [userId]);

  async function loadThreads(
    nextUserId: string,
    fallbackModelId: string,
    fallbackRoleId: string,
    fallbackReasoningEffort: ReasoningEffort,
    mode: "chat" | "work" = appMode,
    selectedWorkspace: DesktopWorkspace | null = workspace
  ) {
    if (mode === "work" && !selectedWorkspace) {
      setThreads([]);
      setActiveThreadId("");
      setEntries([]);
      return;
    }

    const response = await fetch(
      `/api/threads?userId=${encodeURIComponent(nextUserId)}&mode=${mode}${
        mode === "work" && selectedWorkspace
          ? `&workspacePath=${encodeURIComponent(selectedWorkspace.path)}`
          : ""
      }`
    );
    const data = await readJsonResponse(response, "/api/threads");

    if (!response.ok) {
      throw new Error(data.error || "加载对话列表失败。");
    }

    const nextThreads = (data.threads || []) as ChatThread[];
    setThreads(nextThreads);

    if (nextThreads.length) {
      await openThread(nextThreads[0].threadId, nextUserId, nextThreads);
      return;
    }

    await handleCreateThread({
      nextUserId,
      nextModelId: fallbackModelId,
      nextRoleId: fallbackRoleId,
      nextReasoningEffort: fallbackReasoningEffort,
      nextMode: mode,
      nextWorkspace: selectedWorkspace
    });
  }

  async function handleCreateThread(options?: {
    nextUserId?: string;
    nextModelId?: string;
    nextRoleId?: string;
    nextReasoningEffort?: ReasoningEffort;
    nextMode?: "chat" | "work";
    nextWorkspace?: DesktopWorkspace | null;
  }) {
    const nextUserId = options?.nextUserId ?? userId.trim();
    const nextModelId = options?.nextModelId ?? modelId;
    const nextRoleId = options?.nextRoleId ?? roleId;
    const nextReasoningEffort = options?.nextReasoningEffort ?? reasoningEffort;
    const nextMode = options?.nextMode ?? appMode;
    const nextWorkspace = options?.nextWorkspace ?? workspace;

    if (
      !nextUserId ||
      !nextModelId ||
      !nextRoleId ||
      (nextMode === "work" && !nextWorkspace)
    ) {
      return;
    }

    setError("");
    setIsThreadLoading(true);

    try {
      const response = await fetch("/api/threads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          userId: nextUserId,
          modelId: nextModelId,
          roleId: nextRoleId,
          reasoningEffort: nextReasoningEffort,
          mode: nextMode,
          workspacePath: nextMode === "work" ? nextWorkspace?.path : undefined,
          workspaceName: nextMode === "work" ? nextWorkspace?.name : undefined
        })
      });

      const data = await readJsonResponse(response, "/api/threads");
      if (!response.ok) {
        throw new Error(data.error || "创建新对话失败。");
      }

      const thread = data.thread as ChatThread;
      const nextThreads = [thread, ...threads.filter((item) => item.threadId !== thread.threadId)];
      shouldAutoScrollRef.current = true;
      pendingInitialScrollRef.current = true;
      setThreads(nextThreads);
      setActiveThreadId(thread.threadId);
      setEntries([]);
      setActiveDocumentName("");
      setModelId(thread.modelId);
      setRoleId(thread.roleId);
      setReasoningEffort(thread.reasoningEffort || "low");
      sessionStorage.setItem(`chat-demo-active-thread-id-${nextMode}`, thread.threadId);
    } catch (threadError) {
      setError(
        threadError instanceof Error ? threadError.message : "创建新对话失败。"
      );
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function openThread(
    threadId: string,
    nextUserId = userId.trim(),
    sourceThreads = threads
  ) {
    if (!threadId || !nextUserId) {
      return;
    }

    setError("");
    setIsThreadLoading(true);

    try {
      const response = await fetch(
        `/api/threads/${encodeURIComponent(threadId)}/messages?userId=${encodeURIComponent(nextUserId)}`
      );
      const data = await readJsonResponse(response, "/api/threads/:threadId/messages");

      if (!response.ok) {
        throw new Error(data.error || "加载对话失败。");
      }

      const thread = data.thread as ChatThread;
      const nextEntries = ((data.messages || []) as Array<{
        role: "user" | "assistant";
        content: string;
        turnId?: string;
        attachmentName?: string;
        attachmentFileId?: string;
        sources?: DocumentSource[];
      }>).map((entry, index) => {
        const extracted = extractAttachmentFromContent(entry.content);
        const attachmentName = normalizeFileName(
          entry.attachmentName || extracted.attachmentName || ""
        );

        return {
          ...extracted,
          id: `${thread.threadId}-${index}`,
          role: entry.role,
          turnId: entry.turnId,
          // 从 SQLite 恢复出的消息都属于已经结束的历史轮次。
          completed: true,
          meta: `${thread.roleId} | ${thread.modelId} | ${thread.userId}`,
          attachmentName: attachmentName || undefined,
          attachmentFileId: entry.attachmentFileId,
          attachmentPreviewUrl:
            attachmentName && entry.attachmentFileId && isImageFile(attachmentName)
              ? `/api/files/${encodeURIComponent(entry.attachmentFileId)}?userId=${encodeURIComponent(nextUserId)}`
              : undefined,
          sources: entry.sources
        };
      });
      // LangChain 生成的 AIMessage 不携带前端 turnId，恢复时继承最近一条用户消息的 turnId。
      let currentTurnId = "";
      for (const entry of nextEntries) {
        if (entry.role === "user" && entry.turnId) {
          currentTurnId = entry.turnId;
        } else if (entry.role === "assistant" && !entry.turnId) {
          entry.turnId = currentTurnId || undefined;
        }
      }

      shouldAutoScrollRef.current = true;
      pendingInitialScrollRef.current = true;
      setActiveThreadId(thread.threadId);
      setEntries(nextEntries);
      setActiveDocumentName(
        nextEntries.find((entry) => entry.attachmentName)?.attachmentName || ""
      );
      setModelId(thread.modelId);
      setRoleId(thread.roleId);
      setReasoningEffort(thread.reasoningEffort || "low");
      setThreads(
        sourceThreads.map((item) => (item.threadId === thread.threadId ? thread : item))
      );
      sessionStorage.setItem(
        `chat-demo-active-thread-id-${thread.mode || appMode}`,
        thread.threadId
      );
      setSidebarOpen(false);
    } catch (threadError) {
      setError(
        threadError instanceof Error ? threadError.message : "加载对话失败。"
      );
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function refreshThreads(preferredThreadId?: string) {
    const trimmedUserId = userId.trim();
    if (!trimmedUserId) {
      return;
    }

    const response = await fetch(
      `/api/threads?userId=${encodeURIComponent(trimmedUserId)}`
    );
    const data = await readJsonResponse(response, "/api/threads");
    if (!response.ok) {
      throw new Error(data.error || "刷新对话列表失败。");
    }

    const nextThreads = (data.threads || []) as ChatThread[];
    setThreads(nextThreads);

    if (preferredThreadId) {
      const refreshed = nextThreads.find((thread) => thread.threadId === preferredThreadId);
      if (refreshed) {
        setModelId(refreshed.modelId);
        setRoleId(refreshed.roleId);
        setReasoningEffort(refreshed.reasoningEffort || "low");
      }
    }
  }

  async function submitRenameThread(threadId: string) {
    const trimmedTitle = renamingTitle.trim();
    if (!threadId || !userId.trim()) {
      return;
    }

    if (!trimmedTitle) {
      setRenamingThreadId("");
      setRenamingTitle("");
      return;
    }

    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          userId: userId.trim(),
          title: trimmedTitle
        })
      });

      const data = await readJsonResponse(response, "/api/threads/:threadId");
      if (!response.ok) {
        throw new Error(data.error || "重命名对话失败。");
      }

      const renamedThread = data.thread as ChatThread;
      setThreads((prev) =>
        prev.map((thread) =>
          thread.threadId === renamedThread.threadId ? renamedThread : thread
        )
      );
    } catch (renameError) {
      setError(
        renameError instanceof Error ? renameError.message : "重命名对话失败。"
      );
    } finally {
      setRenamingThreadId("");
      setRenamingTitle("");
    }
  }

  async function deleteChatThread(threadId: string) {
    if (!threadId || !userId.trim()) {
      return;
    }

    const thread = threads.find((item) => item.threadId === threadId);
    const confirmed = window.confirm(
      `确定删除「${thread?.title || "这个对话"}」吗？这会删除消息、短期记忆、上传文件和 RAG 索引。`
    );

    if (!confirmed) {
      return;
    }

    setError("");
    setIsThreadLoading(true);

    try {
      const response = await fetch(
        `/api/threads/${encodeURIComponent(threadId)}?userId=${encodeURIComponent(userId.trim())}`,
        {
          method: "DELETE"
        }
      );
      const data = await readJsonResponse(response, "/api/threads/:threadId");

      if (!response.ok) {
        throw new Error(data.error || "删除对话失败。");
      }

      const remainingThreads = threads.filter((item) => item.threadId !== threadId);
      setThreads(remainingThreads);

      if (activeThreadId !== threadId) {
        return;
      }

      const nextThread = remainingThreads[0];
      if (nextThread) {
        await openThread(nextThread.threadId, userId.trim(), remainingThreads);
        return;
      }

      sessionStorage.removeItem("chat-demo-active-thread-id");
      await handleCreateThread({
        nextUserId: userId.trim(),
        nextModelId: modelId,
        nextRoleId: roleId,
        nextReasoningEffort: reasoningEffort
      });
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "删除对话失败。"
      );
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function handleLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isLoggingIn) {
      return;
    }

    const normalizedName = loginName.trim();

    if (!normalizedName || !loginPassword) {
      setLoginError("请输入账号和密码。");
      return;
    }

    try {
      setLoginError("");
      setIsLoggingIn(true);
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username: normalizedName,
          password: loginPassword
        })
      });
      const data = (await response.json()) as AuthSession & { error?: string };

      if (!response.ok) {
        setLoginError(data.error || "登录失败，请检查账号和密码。");
        return;
      }

      localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem("chat-demo-user-id", data.user.id);
      sessionStorage.removeItem("chat-demo-active-thread-id");
      setAuthSession(data);
      setUserId(data.user.id);
      setLoginName("");
      setLoginPassword("");
      setLoginError("");
      setIsLoginOpen(false);
      setEntries([]);
      setActiveThreadId("");
      setThreads([]);

      if (modelId && roleId) {
        await loadThreads(data.user.id, modelId, roleId, reasoningEffort);
      }
    } catch {
      setLoginError("登录请求失败，请确认服务已重启。");
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function handleLogout() {
    const guestUserId = crypto.randomUUID();
    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    localStorage.setItem("chat-demo-user-id", guestUserId);
    sessionStorage.removeItem("chat-demo-active-thread-id");
    setAuthSession(null);
    setUserId(guestUserId);
    setEntries([]);
    setActiveThreadId("");
    setThreads([]);

    if (modelId && roleId) {
      await loadThreads(guestUserId, modelId, roleId, reasoningEffort);
    }
  }

  async function selectDesktopWorkspace() {
    if (!window.desktopAPI) {
      setWorkspaceError("工作目录选择仅在 Electron 桌面版中可用。");
      return;
    }

    try {
      setWorkspaceError("");
      setIsWorkspaceLoading(true);
      const selectedWorkspace = await window.desktopAPI.selectWorkspace(
        userId.trim() || "guest"
      );
      if (selectedWorkspace) {
        setWorkspace(selectedWorkspace);
        if (appMode === "work" && modelId && roleId) {
          await handleCreateThread({
            nextMode: "work",
            nextWorkspace: selectedWorkspace
          });
        }
      }
    } catch (selectError) {
      setWorkspaceError(
        selectError instanceof Error ? selectError.message : "选择工作目录失败。"
      );
    } finally {
      setIsWorkspaceLoading(false);
    }
  }

  async function clearDesktopWorkspace() {
    if (!window.desktopAPI) {
      return;
    }

    await window.desktopAPI.clearWorkspace(userId.trim() || "guest");
    setWorkspace(null);
    setWorkspaceError("");
  }

  async function loadWorkspaceActivities() {
    const response = await fetch(
      `/api/workspace/activity?threadId=${encodeURIComponent(activeThreadId)}&userId=${encodeURIComponent(userId.trim())}`
    );
    const data = await readJsonResponse(response, "/api/workspace/activity");
    if (!response.ok) {
      throw new Error(data.error || "读取工作记录失败。");
    }
    setWorkspaceActivities((data.activities || []) as WorkspaceActivity[]);
  }

  async function uploadDocumentForThread(file: File): Promise<DocumentUploadResult> {
    // 学习点：附件先单独上传。
    // 后端保存原文件，并在 SQLite 里记录 fileId / storageKey / 解析状态。
    if (!activeThreadId || !userId.trim()) {
      throw new Error("No active thread is available for document upload.");
    }

    const formData = new FormData();
    formData.append("threadId", activeThreadId);
    formData.append("userId", userId.trim());
    formData.append("attachment", file);

    const response = await fetch("/api/documents/upload", {
      method: "POST",
      body: formData
    });
    const data = await readJsonResponse(response, "/api/documents/upload");

    if (!response.ok) {
      throw new Error(data.error || "上传文件失败。");
    }

    return data as DocumentUploadResult;
  }

  async function askUploadedDocument(question: string): Promise<DocumentQaResult> {
    // 学习点：文档问答走单独接口。
    // 后端会根据当前 thread 找到附件，再进入 RAG 检索和回答流程。
    const response = await fetch("/api/documents/qa", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: userId.trim(),
        threadId: activeThreadId,
        modelId,
        roleId,
        reasoningEffort,
        question
      })
    });
    const data = await readJsonResponse(response, "/api/documents/qa");

    if (!response.ok) {
      return {
        answer: data.error || "文档问答请求失败。",
        document: {
          fileId: "",
          fileName: activeDocumentName,
          fileType: "unknown",
          storageKey: "",
          parseStatus: "unsupported",
          indexStatus: "unsupported"
        },
        retrieval: {
          strategy: "error",
          topK: 0,
          totalChunks: 0,
          sources: []
        }
      };
    }

    return data as DocumentQaResult;
  }

  async function streamUploadedDocumentAnswer(
    question: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ) {
    const response = await fetch("/api/documents/qa", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({
        userId: userId.trim(),
        threadId: activeThreadId,
        modelId,
        roleId,
        reasoningEffort,
        question
      }),
      signal
    });

    if (!response.ok) {
      const data = await readJsonResponse(response, "/api/documents/qa");
      throw new Error(data.error || "文档问答请求失败。");
    }

    if (!response.body) {
      throw new Error("当前无法获取文档流式响应。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      let eventEnd = buffer.indexOf("\n\n");
      while (eventEnd !== -1) {
        const rawEvent = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);
        if (rawEvent.trim()) {
          applyStreamEvent(rawEvent, onEvent);
        }
        eventEnd = buffer.indexOf("\n\n");
      }

      if (done) {
        break;
      }
    }

    if (buffer.trim()) {
      applyStreamEvent(buffer, onEvent);
    }
  }

  async function handleSubmit(
    event?: FormEvent<HTMLFormElement>,
    messageOverride?: string,
    options?: { hideUserMessage?: boolean }
  ) {
    event?.preventDefault();

    const trimmedMessage = messageOverride?.trim() || message.trim();
    const outgoingMessage =
      trimmedMessage || (attachment ? `I uploaded a file named ${attachment.name}.` : "");

    if (!outgoingMessage || !modelId || !roleId || !userId.trim() || !activeThreadId) {
      return;
    }

    setError("");
    setApprovalRequest(null);
    setIsSubmitting(true);
    shouldAutoScrollRef.current = true;
    const requestController = new AbortController();
    activeRequestControllerRef.current = requestController;

    const isApprovalSubmission =
      Boolean(options?.hideUserMessage) &&
      outgoingMessage.startsWith("__HITL_DECISIONS__:");
    const assistantEntryId = `assistant-${Date.now()}`;
    const turnId =
      isApprovalSubmission && approvalTurnId
        ? approvalTurnId
        : crypto.randomUUID();
    // 文本文件统一进入 LangGraph Agent，由 Agent 决定是否调用 RAG Tool。
    // 图片需要把像素交给视觉模型，因此仍走专用的多模态文档接口。
    const shouldUseDocumentQa = Boolean(
      !isApprovalSubmission &&
        ((attachment && isImageFile(attachment.name)) ||
          (!attachment && activeDocumentName && isImageFile(activeDocumentName)))
    );
    const attachmentPreviewUrl =
      attachment && isImageFile(attachment.name) ? URL.createObjectURL(attachment) : undefined;
    const userEntry: ChatEntry = {
      id: `user-${Date.now()}`,
      role: "user",
      content: outgoingMessage,
      turnId,
      meta: `${currentRole?.label || roleId} | ${currentModel?.label || modelId} | ${userId}`,
      attachmentName: attachment ? normalizeFileName(attachment.name) : undefined,
      attachmentPreviewUrl
    };

    setEntries((prev) => [
      ...prev.filter(
        (entry) =>
          !(
            isApprovalSubmission &&
            entry.role === "assistant" &&
            entry.turnId === turnId &&
            entry.content.startsWith(APPROVAL_PROMPT_PREFIX)
          )
      ),
      ...(options?.hideUserMessage ? [] : [userEntry]),
      {
        id: assistantEntryId,
        role: "assistant",
        turnId,
        completed: false,
        startedAt: Date.now(),
        elapsedMs: 0,
        statusMessage: isApprovalSubmission
          ? APPROVED_ACTION_STATUS_TEXT
          : shouldUseDocumentQa
            ? DOCUMENT_QA_STATUS_TEXT
            : THINKING_STATUS_TEXT,
        content: isApprovalSubmission
          ? APPROVED_ACTION_STATUS_TEXT
          : shouldUseDocumentQa
            ? DOCUMENT_QA_STATUS_TEXT
            : THINKING_STATUS_TEXT,
        meta: `${currentRole?.label || roleId} | ${currentModel?.label || modelId} | ${userId}`
      }
    ]);
    setMessage("");

    try {
      if (shouldUseDocumentQa) {
        let nextDocumentName = activeDocumentName;

        if (attachment) {
          const uploadResult = await uploadDocumentForThread(attachment);
          nextDocumentName = normalizeFileName(uploadResult.document.fileName);
          setActiveDocumentName(nextDocumentName);
          setEntries((prev) =>
            prev.map((entry) =>
              entry.id === userEntry.id
                ? {
                    ...entry,
                    attachmentFileId: uploadResult.document.fileId
                  }
                : entry
            )
          );
        }

        let finalDocumentReply = "";
        const updateDocumentAssistantEntry = (updater: (entry: ChatEntry) => ChatEntry) => {
          setEntries((prev) =>
            prev.map((entry) => (entry.id === assistantEntryId ? updater(entry) : entry))
          );
        };
        await streamUploadedDocumentAnswer(outgoingMessage, (streamEvent) => {
          if (streamEvent.type === "meta") {
            updateDocumentAssistantEntry((entry) => ({
              ...entry,
              meta: `${currentRole?.label || streamEvent.meta.roleId} | ${streamEvent.meta.modelId} | ${streamEvent.meta.userId}`
            }));
            return;
          }

          if (streamEvent.type === "delta") {
            finalDocumentReply += streamEvent.chunk;
            updateDocumentAssistantEntry((entry) => ({
              ...entry,
              content: PENDING_STATUS_TEXTS.has(entry.content)
                ? streamEvent.chunk
                : entry.content + streamEvent.chunk
            }));
            return;
          }

          if (streamEvent.type === "done") {
            finalDocumentReply = streamEvent.reply || finalDocumentReply;
            if (finalDocumentReply.startsWith(APPROVAL_PROMPT_PREFIX)) {
              setApprovalRequest(finalDocumentReply);
              setApprovalTurnId(turnId);
            }
            updateDocumentAssistantEntry((entry) => ({
              ...entry,
              content: finalDocumentReply || "文档问答没有返回内容。",
              completed: !finalDocumentReply.startsWith(APPROVAL_PROMPT_PREFIX),
              meta: `${currentRole?.label || streamEvent.meta.roleId} | ${streamEvent.meta.modelId} | ${streamEvent.meta.userId}`
            }));
            return;
          }

          throw new Error(streamEvent.error || "文档流式请求失败。");
        }, requestController.signal);
        setAttachment(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        await refreshThreads(activeThreadId);
        return;
      }

      const formData = new FormData();
      formData.append("modelId", modelId);
      formData.append("roleId", roleId);
      formData.append("threadId", activeThreadId);
      formData.append("userId", userId.trim());
      formData.append("turnId", turnId);
      // 即使用户只上传文件不输入文字，也给后端一条明确消息，保证本轮会进入 Agent。
      formData.append("message", outgoingMessage);
      formData.append("reasoningEffort", reasoningEffort);

      if (attachment) {
        formData.append("attachment", attachment);
        formData.append("attachmentName", attachment.name);
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        body: formData,
        signal: requestController.signal
      });

      if (!response.ok) {
        const data = await readJsonResponse(response, "/api/chat");
        throw new Error(data.error || "请求失败，请稍后重试。");
      }

      if (!response.body) {
        throw new Error("当前无法获取流式响应。");
      }

      const updateAssistantEntry = (updater: (entry: ChatEntry) => ChatEntry) => {
        setEntries((prev) =>
          prev.map((entry) => (entry.id === assistantEntryId ? updater(entry) : entry))
        );
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalReply = "";

      const handleEvent = (streamEvent: StreamEvent) => {
        if (streamEvent.type === "meta") {
          updateAssistantEntry((entry) => ({
            ...entry,
            meta: `${currentRole?.label || streamEvent.meta.roleId} | ${streamEvent.meta.modelId} | ${streamEvent.meta.userId}`
          }));
          return;
        }

        if (streamEvent.type === "status") {
          updateAssistantEntry((entry) => ({
            ...entry,
            statusMessage: streamEvent.message
          }));
          return;
        }

        if (streamEvent.type === "delta") {
          finalReply += streamEvent.chunk;
          updateAssistantEntry((entry) => ({
            ...entry,
            statusMessage: undefined,
            content: PENDING_STATUS_TEXTS.has(entry.content)
              ? streamEvent.chunk
              : entry.content + streamEvent.chunk
          }));
          return;
        }

        if (streamEvent.type === "done") {
          finalReply = streamEvent.reply || finalReply;
          if (finalReply.startsWith(APPROVAL_PROMPT_PREFIX)) {
            setApprovalRequest(finalReply);
            setApprovalTurnId(turnId);
          }
          updateAssistantEntry((entry) => ({
            ...entry,
            content: finalReply || "模型没有返回内容。",
            completed: !finalReply.startsWith(APPROVAL_PROMPT_PREFIX),
            elapsedMs: entry.startedAt ? Date.now() - entry.startedAt : entry.elapsedMs,
            statusMessage: undefined,
            meta: `${currentRole?.label || streamEvent.meta.roleId} | ${streamEvent.meta.modelId} | ${streamEvent.meta.userId}`
          }));
          return;
        }

        throw new Error(streamEvent.error || "流式请求失败。");
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

        let eventEnd = buffer.indexOf("\n\n");
        while (eventEnd !== -1) {
          const rawEvent = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          if (rawEvent.trim()) {
            applyStreamEvent(rawEvent, handleEvent);
          }
          eventEnd = buffer.indexOf("\n\n");
        }

        if (done) {
          break;
        }
      }

      if (buffer.trim()) {
        applyStreamEvent(buffer, handleEvent);
      }

      setAttachment(null);
      if (attachment) {
        setActiveDocumentName(normalizeFileName(attachment.name));
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      await refreshThreads(activeThreadId);
      if (appMode === "work") {
        await loadWorkspaceActivities();
      }
    } catch (submitError) {
      const wasStopped =
        requestController.signal.aborted ||
        (submitError instanceof DOMException && submitError.name === "AbortError");
      const messageText =
        wasStopped
          ? "已停止"
          : submitError instanceof Error
          ? submitError.message
          : "发送消息时发生错误。";

      // 用户主动停止属于正常操作，不显示成红色请求错误。
      setError(wasStopped ? "" : messageText);
      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === assistantEntryId
            ? {
                ...entry,
                completed: true,
                stopped: wasStopped,
                elapsedMs: entry.startedAt ? Date.now() - entry.startedAt : entry.elapsedMs,
                statusMessage: undefined,
                // 停止时替换“正在思考…”或未完成内容，明确反馈当前任务状态。
                content: wasStopped
                  ? `你在 ${formatElapsedTime(
                      entry.startedAt ? Date.now() - entry.startedAt : entry.elapsedMs || 0
                    )}后停止了`
                  : entry.content || `请求失败：${messageText}`
              }
            : entry
        )
      );
    } finally {
      activeRequestControllerRef.current = null;
      setIsSubmitting(false);
    }
  }

  function submitApprovalDecisions(decisions: ApprovalDecision[]) {
    void handleSubmit(
      undefined,
      `__HITL_DECISIONS__:${JSON.stringify(decisions)}`,
      { hideUserMessage: true }
    );
  }

  function chooseApproval(itemIndex: number, decision: ApprovalDecision) {
    const nextDecisions = {
      ...approvalDecisions,
      [itemIndex]: decision
    };
    setApprovalDecisions(nextDecisions);

    // 单项审批点击即生效；多项审批在最后一项选择后自动提交。
    if (
      approvalItems.every((item) => Boolean(nextDecisions[item.index]))
    ) {
      submitApprovalDecisions(
        approvalItems.map((item) => nextDecisions[item.index])
      );
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) {
        void handleSubmit();
      }
    }
  }

  function handleChatLayoutScroll() {
    const container = chatLayoutRef.current;
    if (!container) {
      return;
    }

    const isScrollingUp = container.scrollTop < lastScrollTopRef.current;
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    // 学习点：用户离底部较近时，才认为可以继续跟随 AI 输出。
    shouldAutoScrollRef.current =
      !isScrollingUp && distanceToBottom <= AUTO_SCROLL_THRESHOLD;
    lastScrollTopRef.current = container.scrollTop;
  }

  function handleChatLayoutWheel(event: React.WheelEvent<HTMLElement>) {
    if (event.deltaY < 0) {
      shouldAutoScrollRef.current = false;
    }
  }

  return (
    <div className="chatgpt-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <div>
            <h1>KimiBai</h1>
          </div>
          <button
            type="button"
            className="sidebar-close"
            onClick={() => setSidebarOpen(false)}
          >
            ×
          </button>
        </div>

        <section className="sidebar-panel sidebar-thread-panel">
          <button
            type="button"
            className="new-thread-button"
            onClick={() => void handleCreateThread()}
            disabled={
              !userId.trim() ||
              !modelId ||
              !roleId ||
              isThreadLoading ||
              (appMode === "work" && !workspace)
            }
          >
            {appMode === "chat" ? "+ 新对话" : "+ 新任务"}
          </button>
          <div className="thread-list">
            {threads.map((thread) => (
              <div
                key={thread.threadId}
                className={`thread-item ${thread.threadId === activeThreadId ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="thread-item-main"
                  onClick={() => void openThread(thread.threadId)}
                >
                  {renamingThreadId === thread.threadId ? (
                    <input
                      className="thread-rename-input"
                      value={renamingTitle}
                      onChange={(event) => setRenamingTitle(event.target.value)}
                      onBlur={() => void submitRenameThread(thread.threadId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submitRenameThread(thread.threadId);
                        }

                        if (event.key === "Escape") {
                          setRenamingThreadId("");
                          setRenamingTitle("");
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="thread-item-title">{thread.title}</span>
                      <span className="thread-item-preview">
                        {thread.lastMessagePreview || "暂无消息"}
                      </span>
                    </>
                  )}
                </button>
                {renamingThreadId === thread.threadId ? null : (
                  <div className="thread-actions">
                    <button
                      type="button"
                      className="thread-rename-button"
                      onClick={() => {
                        setRenamingThreadId(thread.threadId);
                        setRenamingTitle(thread.title);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className="thread-delete-button"
                      onClick={() => void deleteChatThread(thread.threadId)}
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
        <section className="sidebar-account">
          <button
            type="button"
            className="account-button"
            onClick={() => {
              setLoginName((currentName) => currentName || "admin");
              setLoginPassword((currentPassword) => currentPassword || "admin123");
              setLoginError("");
              setIsLoginOpen(true);
            }}
          >
            <span className="account-avatar">
              {authSession ? authSession.user.displayName.slice(0, 1).toUpperCase() : "访"}
            </span>
            <span className="account-info">
              <strong>{authSession ? authSession.user.username : "访客模式"}</strong>
              <small>{authSession ? "记忆已持久化" : "点击登录保存记忆"}</small>
            </span>
          </button>
          {authSession ? (
            <button
              type="button"
              className="account-logout-button"
              onClick={() => void handleLogout()}
            >
              退出
            </button>
          ) : null}
        </section>
      </aside>

      {isLoginOpen ? (
        <div className="login-modal-backdrop" role="presentation">
          <form className="login-modal" onSubmit={handleLoginSubmit}>
            <div className="login-modal-header">
              <div>
                <h2>登录</h2>
                <p>登录后使用固定用户记忆。</p>
              </div>
              <button
                type="button"
                className="login-modal-close"
                onClick={() => setIsLoginOpen(false)}
              >
                ×
              </button>
            </div>
            <label>
              <span>账号</span>
              <input
                value={loginName}
                onChange={(event) => setLoginName(event.target.value)}
                placeholder="admin"
                autoComplete="username"
              />
            </label>
            <label>
              <span>密码</span>
              <input
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="admin123"
                type="password"
                autoComplete="current-password"
              />
            </label>
            {loginError ? <div className="login-error">{loginError}</div> : null}
            <button type="submit" className="login-submit-button" disabled={isLoggingIn}>
              {isLoggingIn ? "登录中..." : "登录"}
            </button>
          </form>
        </div>
      ) : null}

      {approvalRequest ? (
        <div className="login-modal-backdrop" role="presentation">
          <section
            className="login-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-dialog-title"
          >
            <div className="login-modal-header">
              <div>
                <h2 id="approval-dialog-title">需要确认操作</h2>
                <p>Agent 已暂停，确认后才会继续执行。</p>
              </div>
            </div>
            <div className="space-y-3">
              {approvalItems.map((item) => (
                <div
                  key={`${item.index}-${item.toolName}`}
                  className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"
                >
                  <div className="text-sm font-semibold text-zinc-900">
                    {item.index + 1}. {item.toolName}
                  </div>
                  <div className="mt-1 text-sm leading-6 text-zinc-600">
                    {item.description}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                        approvalDecisions[item.index] === "reject"
                          ? "border-rose-500 bg-rose-50 text-rose-700"
                          : "border-zinc-300 bg-white text-zinc-700"
                      }`}
                      disabled={isSubmitting}
                      onClick={() => chooseApproval(item.index, "reject")}
                    >
                      拒绝
                    </button>
                    <button
                      type="button"
                      className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                        approvalDecisions[item.index] === "approve"
                          ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                          : "border-zinc-300 bg-white text-zinc-700"
                      }`}
                      disabled={isSubmitting}
                      onClick={() => chooseApproval(item.index, "approve")}
                    >
                      批准
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {approvalItems.length > 1 ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="rounded-xl border border-zinc-300 bg-white px-4 py-3 font-semibold text-zinc-800 hover:bg-zinc-100"
                disabled={isSubmitting}
                onClick={() =>
                  submitApprovalDecisions(
                    approvalItems.map(() => "reject")
                  )
                }
              >
                全部拒绝
              </button>
              <button
                type="button"
                className="rounded-xl border border-zinc-300 bg-white px-4 py-3 font-semibold text-zinc-800 hover:bg-zinc-100"
                disabled={isSubmitting}
                onClick={() =>
                  submitApprovalDecisions(
                    approvalItems.map(() => "approve")
                  )
                }
              >
                全部批准
              </button>
            </div>
            ) : null}
          </section>
        </div>
      ) : null}

      <main
        ref={chatLayoutRef}
        className={`chat-layout ${isEmptyThread ? "empty-thread" : ""}`}
        onScroll={handleChatLayoutScroll}
        onWheel={handleChatLayoutWheel}
      >
        <header className="chat-header">
          <div className="chat-header-left">
            <button
              type="button"
              className="menu-button"
              onClick={() => setSidebarOpen((value) => !value)}
            >
              ☰
            </button>
            <div>
              <div className="chat-header-title">
                {appMode === "chat" ? "角色对话助手" : workspace?.name || "工作区"}
              </div>
            </div>
          </div>
          <nav className="flex items-center rounded-xl bg-zinc-100 p-1">
            <button
              type="button"
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                appMode === "chat"
                  ? "bg-white text-zinc-950 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-900"
              }`}
              onClick={() => {
                setAppMode("chat");
                setThreads([]);
                setEntries([]);
                setActiveThreadId("");
              }}
            >
              聊天
            </button>
            <button
              type="button"
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                appMode === "work"
                  ? "bg-white text-zinc-950 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-900"
              }`}
              onClick={() => {
                setAppMode("work");
                setThreads([]);
                setEntries([]);
                setActiveThreadId("");
              }}
            >
              工作
            </button>
          </nav>
        </header>

        {error ? <div className="top-error">{error}</div> : null}

        {appMode === "work" && isEmptyThread ? (
          <section className="flex min-h-[calc(100vh-76px)] items-center justify-center px-6 pb-44">
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-200 bg-white text-2xl shadow-sm">
                ◇
              </div>
              <h2 className="mt-7 text-3xl font-medium tracking-tight text-zinc-900">
                {workspace
                  ? `要在 ${workspace.name} 内开发什么？`
                  : "选择一个项目开始工作"}
              </h2>
              {!workspace ? (
                <button
                  type="button"
                  className="mt-7 rounded-xl bg-zinc-950 px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:bg-zinc-300"
                  disabled={isWorkspaceLoading}
                  onClick={() => void selectDesktopWorkspace()}
                >
                  {isWorkspaceLoading ? "正在读取目录…" : "打开文件夹"}
                </button>
              ) : null}
              {workspaceError ? (
                <div className="mx-auto mt-5 max-w-lg rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {workspaceError}
                </div>
              ) : null}
            </div>
          </section>
        ) : (
        <section className="conversation">
          {isLoading || isThreadLoading ? (
            <div className="empty-state">
              <div className="empty-state-title">
                {isLoading ? "正在加载配置" : "正在加载对话"}
              </div>
              <div className="empty-state-copy">
                {isLoading
                  ? "正在获取模型和角色。"
                  : "正在从 SQLite 恢复对话消息。"}
              </div>
            </div>
          ) : null}

          {appMode === "chat" && isEmptyThread ? (
            <div className="chat-empty-home">
              <h2>今天想聊什么？</h2>
              <div className="chat-empty-actions">
                <button type="button" onClick={() => setMessage("帮我分析这个文件")}>
                  分析文件
                </button>
                <button type="button" onClick={() => setMessage("帮我写一段代码")}>
                  写代码
                </button>
                <button type="button" onClick={() => setMessage("帮我梳理一个学习计划")}>
                  制定计划
                </button>
              </div>
            </div>
          ) : null}

          {!isLoading &&
            !isThreadLoading &&
            entries.map((entry, entryIndex) => {
              const isLastAssistantForTurn =
                entry.role === "assistant" &&
                !entries
                  .slice(entryIndex + 1)
                  .some(
                    (candidate) =>
                      candidate.role === "assistant" &&
                      candidate.turnId === entry.turnId
                  );
              const turnActivities =
                entry.role === "assistant" &&
                entry.completed !== false &&
                isLastAssistantForTurn
                  ? [
                      ...workspaceActivities.filter(
                        (activity) =>
                          Boolean(activity.turnId) &&
                          activity.turnId === entry.turnId &&
                          activity.activityType === "file_write" &&
                          activity.filePath
                      ),
                      ...(legacyActivityByEntryId.get(entry.id) || [])
                    ]
                  : [];
              const changedFiles = Array.from(
                new Set(turnActivities.map((activity) => activity.filePath as string))
              );
              return (
              <div
                key={entry.id}
                className={`mx-auto grid w-[min(860px,calc(100%_-_32px))] gap-3 px-0 py-5 ${
                  entry.role === "user" ? "justify-items-end" : "justify-items-start"
                }`}
              >
                <div
                  className={`flex w-full items-center gap-2 text-[13px] ${
                    entry.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <span className="font-semibold text-zinc-950">
                    {entry.role === "user" ? "你" : currentRole?.label || "助手"}
                  </span>
                  {entry.meta ? (
                    <span className="max-w-[68vw] truncate text-xs font-normal text-zinc-500">
                      {entry.meta}
                    </span>
                  ) : null}
                </div>
                <div
                  className={`max-w-full ${
                    entry.role === "user"
                      ? "rounded-3xl bg-zinc-100 px-5 py-3 text-[15px] leading-8 text-zinc-950"
                      : "w-full text-[15px] leading-8 text-zinc-950"
                  }`}
                >
                    {entry.attachmentName ? (
                      <button
                        type="button"
                        className={`message-attachment-card ${
                          entry.attachmentPreviewUrl ? "image-only" : "file-card"
                        }`}
                        onClick={() => {
                          if (entry.attachmentFileId) {
                            window.open(
                              `/api/files/${encodeURIComponent(entry.attachmentFileId)}?userId=${encodeURIComponent(userId.trim())}`,
                              "_blank",
                              "noopener,noreferrer"
                            );
                          }
                        }}
                        disabled={!entry.attachmentFileId}
                        title={
                          entry.attachmentFileId
                            ? "打开上传文件"
                            : "文件上传完成后可以预览"
                        }
                      >
                        {entry.attachmentPreviewUrl ? (
                          <img
                            className="message-attachment-preview"
                            src={entry.attachmentPreviewUrl}
                            alt="上传的图片"
                          />
                        ) : (
                          <>
                            <div className="message-attachment-icon">
                              {getAttachmentKind(entry.attachmentName)}
                            </div>
                            <div className="message-attachment-info">
                              <div className="message-attachment-name">
                                {entry.attachmentName}
                              </div>
                              <div className="message-attachment-copy">
                                {getAttachmentKind(entry.attachmentName)}
                              </div>
                            </div>
                          </>
                        )}
                      </button>
                    ) : null}
                    {entry.role === "assistant" ? (
                      <>
                        {entry.completed === false ? (
                          <div className="agent-progress" role="status" aria-live="polite">
                            <span className="agent-progress-dot" aria-hidden="true" />
                            <span>
                              {entry.statusMessage || "正在生成回答…"}
                              {entry.startedAt
                                ? ` 已处理 ${formatElapsedTime(progressClock - entry.startedAt)}`
                                : ""}
                            </span>
                          </div>
                        ) : entry.elapsedMs !== undefined && !entry.stopped ? (
                          <div className="agent-elapsed">
                            已处理 {formatElapsedTime(entry.elapsedMs)}
                          </div>
                        ) : null}
                        {!PENDING_STATUS_TEXTS.has(entry.content) || entry.completed !== false ? (
                          <div className="markdown-body">{renderMarkdown(entry.content)}</div>
                        ) : null}
                        {changedFiles.length ? (
                          <section className="work-activity-card work-activity-inline">
                            <header>
                              <strong>已编辑 {changedFiles.length} 个文件</strong>
                              <span className="work-activity-caption">Agent 工作记录</span>
                            </header>
                            {changedFiles.map((filePath) => (
                              <div className="work-file-row" key={filePath}>
                                <span>{filePath}</span>
                                <span className="work-file-status">
                                  +{turnActivities
                                    .filter((item) => item.filePath === filePath)
                                    .reduce((total, item) => total + (item.additions || 0), 0)}
                                  {" "}
                                  -{turnActivities
                                    .filter((item) => item.filePath === filePath)
                                    .reduce((total, item) => total + (item.deletions || 0), 0)}
                                </span>
                              </div>
                            ))}
                          </section>
                        ) : null}
                      </>
                    ) : (
                      <div className="message-text">{entry.content}</div>
                    )}
                </div>
              </div>
            )})}
        </section>
        )}

        <footer
          ref={composerShellRef}
          className={`composer-shell ${
            isEmptyThread
              ? "home-composer"
              : ""
          }`}
        >
          <form className="composer-card" onSubmit={handleSubmit}>
            {appMode === "work" ? (
              <div className="mb-2 flex min-h-10 items-center gap-1 border-b border-zinc-100 pb-2 text-xs text-zinc-600">
                <button
                  type="button"
                  className="flex max-w-[45%] items-center gap-2 rounded-lg px-2.5 py-2 font-semibold text-zinc-800 hover:bg-zinc-100"
                  onClick={() => void selectDesktopWorkspace()}
                  title={workspace?.path || "选择工作目录"}
                >
                  <span>▱</span>
                  <span className="truncate">
                    {workspace?.name || "选择项目"}
                  </span>
                  <span className="text-zinc-400">⌄</span>
                </button>
                {workspace ? (
                  <>
                    <span className="rounded-lg px-2.5 py-2 text-zinc-500">
                      ⎇ {workspace.branch || "无 Git"}
                    </span>
                    <button
                      type="button"
                      className="ml-auto rounded-lg px-2.5 py-2 text-zinc-400 hover:bg-rose-50 hover:text-rose-600"
                      onClick={() => void clearDesktopWorkspace()}
                    >
                      移除
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {attachment ? (
              <div
                className={`composer-attachment-preview ${
                  composerAttachmentPreviewUrl ? "image-only" : "file-card"
                }`}
              >
                {composerAttachmentPreviewUrl ? (
                  <img src={composerAttachmentPreviewUrl} alt="待上传图片" />
                ) : (
                  <>
                    <div className="composer-file-icon">
                      {getAttachmentKind(attachment.name)}
                    </div>
                    <div className="composer-file-info">
                      <strong>{normalizeFileName(attachment.name)}</strong>
                      <span>{getAttachmentKind(attachment.name)}</span>
                    </div>
                  </>
                )}
                <button
                  type="button"
                  aria-label="移除附件"
                  onClick={() => {
                    setAttachment(null);
                    if (fileInputRef.current) {
                      fileInputRef.current.value = "";
                    }
                  }}
                >
                  ×
                </button>
              </div>
            ) : null}

            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder="输入消息。按 Enter 发送，Shift + Enter 换行。"
              rows={1}
              required
            />

            <input
              ref={fileInputRef}
              className="hidden-file-input"
              type="file"
              onChange={(event) => {
                setAttachment(event.target.files?.[0] || null);
              }}
            />

            <div className="composer-actions">
              <div className="composer-controls">
                <button
                  type="button"
                  className="attach-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSubmitting || isThreadLoading}
                >
                  上传
                </button>
                <label className="composer-role-picker" htmlFor="composer-model-select">
                  <span>模型</span>
                  <select
                    id="composer-model-select"
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    disabled={!models.length || isSubmitting || isThreadLoading}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="composer-role-picker" htmlFor="composer-role-select">
                  <span>角色</span>
                  <select
                    id="composer-role-select"
                    value={roleId}
                    onChange={(event) => setRoleId(event.target.value)}
                    disabled={!roles.length || isSubmitting || isThreadLoading}
                  >
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </label>
                {currentModel?.provider === "openai" ? (
                  <label
                    className="composer-role-picker"
                    htmlFor="composer-reasoning-effort"
                  >
                    <span>推理</span>
                    <select
                      id="composer-reasoning-effort"
                      value={reasoningEffort}
                      onChange={(event) =>
                        setReasoningEffort(event.target.value as ReasoningEffort)
                      }
                      disabled={isSubmitting || isThreadLoading}
                    >
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </label>
                ) : null}
                {isSubmitting ? (
                  <button
                    className="send-button"
                    type="button"
                    onClick={() => activeRequestControllerRef.current?.abort()}
                  >
                    停止
                  </button>
                ) : (
                  <button className="send-button" type="submit" disabled={!canSubmit}>
                    发送
                  </button>
                )}
              </div>
            </div>
          </form>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
