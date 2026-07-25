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

type ProviderId = "deepseek" | "openai" | "siliconflow";
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
        "Welcome. Start a new chat or open an existing thread. Long-term memory is isolated by userId, while each thread keeps its own short-term context."
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
  const chatLayoutRef = useRef<HTMLElement | null>(null);
  const composerShellRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const pendingInitialScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  useLayoutEffect(() => {
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
      try {
        const [modelsResponse, rolesResponse] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/roles")
        ]);

        const modelsData = await readJsonResponse(modelsResponse, "/api/models");
        const rolesData = await readJsonResponse(rolesResponse, "/api/roles");

        if (!modelsResponse.ok) {
          throw new Error(modelsData.error || "Failed to load models.");
        }

        if (!rolesResponse.ok) {
          throw new Error(rolesData.error || "Failed to load roles.");
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
          loadError instanceof Error ? loadError.message : "Failed to initialize."
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
      throw new Error(data.error || "Failed to load threads.");
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
        throw new Error(data.error || "Failed to create thread.");
      }

      const thread = data.thread as ChatThread;
      const nextThreads = [thread, ...threads.filter((item) => item.threadId !== thread.threadId)];
      shouldAutoScrollRef.current = true;
      pendingInitialScrollRef.current = true;
      setThreads(nextThreads);
      setActiveThreadId(thread.threadId);
      setEntries(createWelcomeEntries());
      setModelId(thread.modelId);
      setRoleId(thread.roleId);
      setReasoningEffort(thread.reasoningEffort || "low");
      sessionStorage.setItem("chat-demo-active-thread-id", thread.threadId);
    } catch (threadError) {
      setError(
        threadError instanceof Error ? threadError.message : "Failed to create thread."
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
        throw new Error(data.error || "Failed to load thread.");
      }

      const thread = data.thread as ChatThread;
      const nextEntries = ((data.messages || []) as Array<{
        role: "user" | "assistant";
        content: string;
      }>).map((entry, index) => ({
        ...extractAttachmentFromContent(entry.content),
        id: `${thread.threadId}-${index}`,
        role: entry.role,
        meta: `${thread.roleId} | ${thread.modelId} | ${thread.userId}`
      }));

      shouldAutoScrollRef.current = true;
      pendingInitialScrollRef.current = true;
      setActiveThreadId(thread.threadId);
      setEntries(nextEntries.length ? nextEntries : createWelcomeEntries());
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
        threadError instanceof Error ? threadError.message : "Failed to load thread."
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
      throw new Error(data.error || "Failed to refresh threads.");
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
        throw new Error(data.error || "Failed to rename thread.");
      }

      const renamedThread = data.thread as ChatThread;
      setThreads((prev) =>
        prev.map((thread) =>
          thread.threadId === renamedThread.threadId ? renamedThread : thread
        )
      );
    } catch (renameError) {
      setError(
        renameError instanceof Error ? renameError.message : "Failed to rename thread."
      );
    } finally {
      setRenamingThreadId("");
      setRenamingTitle("");
    }
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
    const userEntry: ChatEntry = {
      id: `user-${Date.now()}`,
      role: "user",
      content: outgoingMessage,
      meta: `${currentRole?.label || roleId} | ${currentModel?.label || modelId} | ${userId}`,
      attachmentName: attachment?.name
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
        throw new Error(data.error || "Request failed. Please try again.");
      }

      if (!response.body) {
        throw new Error("Streaming response is unavailable.");
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
            content: finalReply || "Model returned no content.",
            meta: `${currentRole?.label || streamEvent.meta.roleId} | ${streamEvent.meta.modelId} | ${streamEvent.meta.userId}`
          }));
          return;
        }

        throw new Error(streamEvent.error || "Streaming request failed.");
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
          : "An error occurred while sending the message.";

      setError(messageText);
      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === assistantEntryId
            ? {
                ...entry,
                content: entry.content || `Request failed: ${messageText}`
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
            + New chat
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
                        {thread.lastMessagePreview || "No messages yet"}
                      </span>
                    </>
                  )}
                </button>
                {renamingThreadId === thread.threadId ? null : (
                  <button
                    type="button"
                    className="thread-rename-button"
                    onClick={() => {
                      setRenamingThreadId(thread.threadId);
                      setRenamingTitle(thread.title);
                    }}
                  >
                    Rename
                  </button>
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
              <div className="chat-header-title">Role ChatGPT UI</div>
            </div>
          </div>
        </header>

        {error ? <div className="top-error">{error}</div> : null}

        <section className="conversation">
          {isLoading || isThreadLoading ? (
            <div className="empty-state">
              <div className="empty-state-title">
                {isLoading ? "Loading configuration" : "Loading thread"}
              </div>
              <div className="empty-state-copy">
                {isLoading
                  ? "Fetching models and roles."
                  : "Restoring messages from SQLite checkpoints."}
              </div>
            </div>
          ) : null}

          {!isLoading &&
            !isThreadLoading &&
            entries.map((entry) => (
              <div key={entry.id} className={`chat-row ${entry.role}`}>
                <div className="chat-avatar">{entry.role === "user" ? "You" : "AI"}</div>
                <div className="chat-bubble-wrap">
                  <div className="chat-bubble-header">
                    <span>{entry.role === "user" ? "You" : currentRole?.label || "Assistant"}</span>
                    {entry.meta ? <span className="chat-meta">{entry.meta}</span> : null}
                  </div>
                  <div className={`chat-bubble ${entry.role}`}>
                    {entry.attachmentName ? (
                      <div className="message-attachment-card">
                        <div className="message-attachment-icon">FILE</div>
                        <div className="message-attachment-info">
                          <div className="message-attachment-name">
                            {entry.attachmentName}
                          </div>
                          <div className="message-attachment-copy">Uploaded document</div>
                        </div>
                      </div>
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
                  Remove
                </button>
              </div>
            ) : null}

            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder="Send a message. Enter to send, Shift+Enter for a new line."
              rows={1}
              required
            />

            <input
              ref={fileInputRef}
              className="hidden-file-input"
              type="file"
              accept=".md,.markdown,.txt,.pdf"
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
                  Attach
                </button>
                <label className="composer-role-picker" htmlFor="composer-model-select">
                  <span>Model</span>
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
                  <span>Role</span>
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
                    <span>Reasoning</span>
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
                  {isSubmitting ? "Streaming..." : "Send"}
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
