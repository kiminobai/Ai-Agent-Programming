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

type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
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
  | { type: "delta"; chunk: string }
  | { type: "done"; reply: string; meta: StreamMeta }
  | { type: "error"; error: string };

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
  const existingValue = sessionStorage.getItem(storageKey);
  if (existingValue) {
    return existingValue;
  }

  const nextValue = crypto.randomUUID();
  sessionStorage.setItem(storageKey, nextValue);
  return nextValue;
}

function createWelcomeEntries(): ChatEntry[] {
  return [
    {
      id: "welcome",
      role: "assistant",
      content:
        "欢迎使用。你可以新建对话，或从左侧打开已有对话。长期记忆会按用户隔离，每个对话也会保留自己的短期上下文。"
    }
  ];
}

const AUTO_SCROLL_THRESHOLD = 120;
const ATTACHMENT_MARKER_PATTERN =
  /\n*\[Attachment available in current thread: ([^\]]+)\]\n(?:If the user wants analysis, extraction, chunking, summarization, or document QA, call inspect_uploaded_document\.|If the user asks to use the file content, call chunk_uploaded_document to split it into bounded chunks before answering\.|If the user asks to use the file content, call retrieve_uploaded_document_chunks to retrieve only relevant chunks before answering\.)/;

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
    return "\u56fe\u7247\u6587\u4ef6";
  }

  if (extension === "pptx") {
    return "\u6f14\u793a\u6587\u7a3f";
  }

  if (extension === "docx") {
    return "Word \u6587\u6863";
  }

  if (["xlsx", "xls", "csv"].includes(extension)) {
    return "\u8868\u683c\u6587\u4ef6";
  }

  if (["html", "htm"].includes(extension)) {
    return "\u7f51\u9875\u6587\u4ef6";
  }

  if (extension === "pdf") {
    return "PDF \u6587\u6863";
  }

  return "\u77e5\u8bc6\u5e93\u6587\u4ef6";
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
  const [entries, setEntries] = useState<ChatEntry[]>(createWelcomeEntries());
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState("");
  const [renamingTitle, setRenamingTitle] = useState("");
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userId] = useState(() => getOrCreateStoredId("chat-demo-user-id"));
  const [attachment, setAttachment] = useState<File | null>(null);
  const [activeDocumentName, setActiveDocumentName] = useState("");
  const chatLayoutRef = useRef<HTMLElement | null>(null);
  const composerShellRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const pendingInitialScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);

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

  const currentModel = useMemo(
    () => models.find((item) => item.id === modelId),
    [models, modelId]
  );
  const currentRole = useMemo(
    () => roles.find((item) => item.id === roleId),
    [roles, roleId]
  );
  const canSubmit = Boolean(
    !isSubmitting &&
      !isLoading &&
      !isThreadLoading &&
      activeThreadId &&
      modelId &&
      roleId &&
      (message.trim() || attachment)
  );

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
          await loadThreads(userId.trim(), nextModelId, nextRoleId, "low");
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
    fallbackReasoningEffort: ReasoningEffort
  ) {
    const response = await fetch(
      `/api/threads?userId=${encodeURIComponent(nextUserId)}`
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
      nextReasoningEffort: fallbackReasoningEffort
    });
  }

  async function handleCreateThread(options?: {
    nextUserId?: string;
    nextModelId?: string;
    nextRoleId?: string;
    nextReasoningEffort?: ReasoningEffort;
  }) {
    const nextUserId = options?.nextUserId ?? userId.trim();
    const nextModelId = options?.nextModelId ?? modelId;
    const nextRoleId = options?.nextRoleId ?? roleId;
    const nextReasoningEffort = options?.nextReasoningEffort ?? reasoningEffort;

    if (!nextUserId || !nextModelId || !nextRoleId) {
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
          reasoningEffort: nextReasoningEffort
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
      setEntries(createWelcomeEntries());
      setActiveDocumentName("");
      setModelId(thread.modelId);
      setRoleId(thread.roleId);
      setReasoningEffort(thread.reasoningEffort || "low");
      sessionStorage.setItem("chat-demo-active-thread-id", thread.threadId);
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

      shouldAutoScrollRef.current = true;
      pendingInitialScrollRef.current = true;
      setActiveThreadId(thread.threadId);
      setEntries(nextEntries.length ? nextEntries : createWelcomeEntries());
      setActiveDocumentName(
        nextEntries.find((entry) => entry.attachmentName)?.attachmentName || ""
      );
      setModelId(thread.modelId);
      setRoleId(thread.roleId);
      setReasoningEffort(thread.reasoningEffort || "low");
      setThreads(
        sourceThreads.map((item) => (item.threadId === thread.threadId ? thread : item))
      );
      sessionStorage.setItem("chat-demo-active-thread-id", thread.threadId);
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

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const trimmedMessage = message.trim();
    const outgoingMessage =
      trimmedMessage || (attachment ? `I uploaded a file named ${attachment.name}.` : "");

    if (!outgoingMessage || !modelId || !roleId || !userId.trim() || !activeThreadId) {
      return;
    }

    setError("");
    setIsSubmitting(true);
    shouldAutoScrollRef.current = true;

    const assistantEntryId = `assistant-${Date.now()}`;
    const attachmentPreviewUrl =
      attachment && isImageFile(attachment.name) ? URL.createObjectURL(attachment) : undefined;
    const userEntry: ChatEntry = {
      id: `user-${Date.now()}`,
      role: "user",
      content: outgoingMessage,
      meta: `${currentRole?.label || roleId} | ${currentModel?.label || modelId} | ${userId}`,
      attachmentName: attachment ? normalizeFileName(attachment.name) : undefined,
      attachmentPreviewUrl
    };

    setEntries((prev) => [
      ...prev,
      userEntry,
      {
        id: assistantEntryId,
        role: "assistant",
        content: "",
        meta: `${currentRole?.label || roleId} | ${currentModel?.label || modelId} | ${userId}`
      }
    ]);
    setMessage("");

    try {
      const shouldUseDocumentQa = Boolean(attachment || activeDocumentName);

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

        const qaResult = await askUploadedDocument(outgoingMessage);
        setEntries((prev) =>
          prev.map((entry) =>
            entry.id === assistantEntryId
              ? {
                  ...entry,
                  content: qaResult.answer || "文档问答没有返回内容。",
                  meta: `${currentRole?.label || roleId} | ${currentModel?.label || modelId} | ${userId}`,
                  sources: qaResult.retrieval.sources
                }
              : entry
          )
        );
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
      // 即使用户只上传文件不输入文字，也给后端一条明确消息，保证本轮会进入 Agent。
      formData.append("message", outgoingMessage);
      formData.append("reasoningEffort", reasoningEffort);

      if (attachment) {
        formData.append("attachment", attachment);
        formData.append("attachmentName", attachment.name);
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        body: formData
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

        if (streamEvent.type === "delta") {
          finalReply += streamEvent.chunk;
          updateAssistantEntry((entry) => ({
            ...entry,
            content: entry.content + streamEvent.chunk
          }));
          return;
        }

        if (streamEvent.type === "done") {
          finalReply = streamEvent.reply || finalReply;
          updateAssistantEntry((entry) => ({
            ...entry,
            content: finalReply || "模型没有返回内容。",
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
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      await refreshThreads(activeThreadId);
    } catch (submitError) {
      const messageText =
        submitError instanceof Error
          ? submitError.message
          : "发送消息时发生错误。";

      setError(messageText);
      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === assistantEntryId
            ? {
                ...entry,
                content: entry.content || `请求失败：${messageText}`
              }
            : entry
        )
      );
    } finally {
      setIsSubmitting(false);
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
            <h1>ChatGPT</h1>
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
            disabled={!userId.trim() || !modelId || !roleId || isThreadLoading}
          >
            + 新对话
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
      </aside>

      <main
        ref={chatLayoutRef}
        className="chat-layout"
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
              <div className="chat-header-title">角色对话助手</div>
            </div>
          </div>
        </header>

        {error ? <div className="top-error">{error}</div> : null}

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

          {!isLoading &&
            !isThreadLoading &&
            entries.map((entry) => (
              <div key={entry.id} className={`chat-row ${entry.role}`}>
                <div className="chat-avatar">{entry.role === "user" ? "你" : "AI"}</div>
                <div className="chat-bubble-wrap">
                  <div className="chat-bubble-header">
                    <span>{entry.role === "user" ? "你" : currentRole?.label || "助手"}</span>
                    {entry.meta ? <span className="chat-meta">{entry.meta}</span> : null}
                  </div>
                  <div className={`chat-bubble ${entry.role}`}>
                    {entry.attachmentName ? (
                      <button
                        type="button"
                        className="message-attachment-card"
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
                            alt={entry.attachmentName}
                          />
                        ) : (
                          <div className="message-attachment-icon">文件</div>
                        )}
                        <div className="message-attachment-info">
                          <div className="message-attachment-name">
                            {entry.attachmentName}
                          </div>
                          <div className="message-attachment-copy">
                            {getAttachmentKind(entry.attachmentName)}
                          </div>
                        </div>
                      </button>
                    ) : null}
                    {entry.role === "assistant" ? (
                      <div className="markdown-body">{renderMarkdown(entry.content)}</div>
                    ) : (
                      <div className="message-text">{entry.content}</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
        </section>

        <footer ref={composerShellRef} className="composer-shell">
          <form className="composer-card" onSubmit={handleSubmit}>
            {activeDocumentName ? (
              <div className="knowledge-chip">
                <span>{"\u77e5\u8bc6\u5e93\u6587\u4ef6"}</span>
                <strong>{normalizeFileName(activeDocumentName)}</strong>
              </div>
            ) : null}
            {attachment ? (
              <div className="composer-attachment-chip">
                <span>{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setAttachment(null);
                    if (fileInputRef.current) {
                      fileInputRef.current.value = "";
                    }
                  }}
                >
                  移除
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
                <button className="send-button" type="submit" disabled={!canSubmit}>
                  {isSubmitting ? "生成中..." : "发送"}
                </button>
              </div>
            </div>
          </form>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
