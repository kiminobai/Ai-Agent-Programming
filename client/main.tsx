/**
 * React 单页聊天界面。
 * 负责模型/角色选择、SSE 增量解析和对话状态展示。
 */
import React, { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
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
};

type StreamMeta = {
  provider: ProviderId;
  modelId: string;
  modelLabel: string;
  roleId: string;
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
    throw new Error(`${apiName} returned non-JSON content. Please restart the backend with the latest code.`);
  }
}

function applyStreamEvent(rawEvent: string, onEvent: (event: StreamEvent) => void) {
  // 一个 SSE 数据块可能包含多行，只解析 data: 开头的有效负载。
  const lines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (const line of lines) {
    onEvent(JSON.parse(line) as StreamEvent);
  }
}

function getOrCreateThreadId(): string {
  const storageKey = "chat-demo-thread-id";
  const existingThreadId = sessionStorage.getItem(storageKey);
  if (existingThreadId) {
    return existingThreadId;
  }

  // 当前浏览器标签页复用同一个 ID，让后端恢复上一轮 Agent State。
  const threadId = crypto.randomUUID();
  sessionStorage.setItem(storageKey, threadId);
  return threadId;
}

function App() {
  // 模型和角色由服务端驱动，API Key 永远不会进入浏览器状态。
  const [models, setModels] = useState<ModelOption[]>([]);
  const [roles, setRoles] = useState<PromptRole[]>([]);
  const [modelId, setModelId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("low");
  const [message, setMessage] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Welcome. Choose a model and role, then start chatting."
    }
  ]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  // threadId 在整个对话期间保持稳定，不随 React 重新渲染而改变。
  const threadIdRef = useRef(getOrCreateThreadId());

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

        setModels(enabledModels);
        setRoles(availableRoles);
        setModelId(enabledModels[0]?.id || "");
        setRoleId(
          availableRoles.some((item: PromptRole) => item.id === rolesData.defaultRoleId)
            ? rolesData.defaultRoleId
            : availableRoles[0]?.id || ""
        );
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to initialize.");
      } finally {
        setIsLoading(false);
      }
    }

    void bootstrap();
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries, isSubmitting]);

  const currentModel = useMemo(
    () => models.find((item) => item.id === modelId),
    [models, modelId]
  );

  const currentRole = useMemo(
    () => roles.find((item) => item.id === roleId),
    [roles, roleId]
  );

  const canSubmit = Boolean(!isSubmitting && !isLoading && modelId && roleId && message.trim());

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    // 步骤 1：阻止表单刷新页面，并读取当前输入。
    event?.preventDefault();

    const trimmedMessage = message.trim();
    if (!trimmedMessage || !modelId || !roleId) {
      return;
    }

    // 步骤 2：锁定提交状态，防止用户重复发送。
    setError("");
    setIsSubmitting(true);

    // 步骤 3：先在 UI 插入用户消息与空助手消息，提供即时反馈。
    const assistantEntryId = `assistant-${Date.now()}`;
    const userEntry: ChatEntry = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmedMessage,
      meta: `${currentRole?.label || roleId} · ${currentModel?.label || modelId}`
    };

    setEntries((prev) => [
      ...prev,
      userEntry,
      {
        id: assistantEntryId,
        role: "assistant",
        content: "",
        meta: `${currentRole?.label || roleId} · ${currentModel?.label || modelId}`
      }
    ]);
    setMessage("");

    try {
      // 步骤 4：向后端发送模型、角色和本次用户消息。
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          modelId,
          roleId,
          threadId: threadIdRef.current,
          message: trimmedMessage,
          reasoningEffort: currentModel?.provider === "openai" ? reasoningEffort : undefined
        })
      });

      // 步骤 5：普通 HTTP 错误在进入 SSE 读取前处理。
      if (!response.ok) {
        const data = await readJsonResponse(response, "/api/chat");
        throw new Error(data.error || "Request failed. Please try again.");
      }

      if (!response.body) {
        throw new Error("Streaming response is unavailable.");
      }

      // 步骤 6：所有流式事件只更新本次请求对应的助手消息。
      const updateAssistantEntry = (updater: (entry: ChatEntry) => ChatEntry) => {
        setEntries((prev) =>
          prev.map((entry) => (entry.id === assistantEntryId ? updater(entry) : entry))
        );
      };

      // 步骤 7：Reader 获取二进制块，Decoder 将其增量转换为 UTF-8 文本。
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalReply = "";

      // 步骤 8：按 meta、delta、done、error 四种事件更新状态。
      const handleEvent = (streamEvent: StreamEvent) => {
        if (streamEvent.type === "meta") {
          updateAssistantEntry((entry) => ({
            ...entry,
            meta: `${currentRole?.label || streamEvent.meta.roleId} · ${streamEvent.meta.modelId}`
          }));
          return;
        }

        if (streamEvent.type === "delta") {
          // delta 到达一次就追加一次，形成逐字输出效果。
          finalReply += streamEvent.chunk;
          updateAssistantEntry((entry) => ({
            ...entry,
            content: entry.content + streamEvent.chunk
          }));
          return;
        }

        if (streamEvent.type === "done") {
          // done 携带服务端完整答案，用于纠正可能遗漏的最后一个分片。
          finalReply = streamEvent.reply || finalReply;
          updateAssistantEntry((entry) => ({
            ...entry,
            content: finalReply || "Model returned no content.",
            meta: `${currentRole?.label || streamEvent.meta.roleId} · ${streamEvent.meta.modelId}`
          }));
          return;
        }

        throw new Error(streamEvent.error || "Streaming request failed.");
      };

      // 步骤 9：持续读取网络块；一个块可能含半个或多个 SSE 事件。
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

        // SSE 事件以空行分隔；不完整尾部继续留在 buffer 等待下个块。
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

      // 步骤 10：连接结束后处理 Decoder 缓冲区中的最后一个事件。
      if (buffer.trim()) {
        applyStreamEvent(buffer, handleEvent);
      }
    } catch (submitError) {
      // 步骤 11：请求失败时保留已收到内容，并在空消息中展示错误。
      const messageText =
        submitError instanceof Error ? submitError.message : "An error occurred while sending the message.";

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
      // 步骤 12：无论成功失败都解除输入锁定。
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

  return (
    <div className="chatgpt-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <div>
            <p className="sidebar-kicker">Role Chat</p>
            <h1>Chat Settings</h1>
          </div>
          <button
            type="button"
            className="sidebar-close"
            onClick={() => setSidebarOpen(false)}
          >
            ×
          </button>
        </div>

        <section className="sidebar-panel">
          <label className="sidebar-label" htmlFor="model-select">
            Model
          </label>
          <select
            id="model-select"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            disabled={!models.length || isLoading}
          >
            {models.length ? null : <option value="">No available model</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <p className="sidebar-help">
            {currentModel
              ? `${currentModel.label} · ${currentModel.description}`
              : "Please configure at least one available model."}
          </p>
        </section>

        <section className="sidebar-panel">
          <div className="sidebar-label">Role</div>
          <div className="role-list">
            {roles.map((role) => (
              <button
                key={role.id}
                type="button"
                className={`role-option ${role.id === roleId ? "active" : ""}`}
                onClick={() => {
                  setRoleId(role.id);
                  setSidebarOpen(false);
                }}
              >
                <span className="role-option-name">{role.label}</span>
                <span className="role-option-summary">{role.summary}</span>
              </button>
            ))}
          </div>
        </section>

        {currentModel?.provider === "openai" ? (
          <section className="sidebar-panel">
            <label className="sidebar-label" htmlFor="reasoning-effort">
              Reasoning
            </label>
            <select
              id="reasoning-effort"
              value={reasoningEffort}
              onChange={(event) =>
                setReasoningEffort(event.target.value as ReasoningEffort)
              }
            >
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <p className="sidebar-help">
              This only applies to OpenAI Responses API requests.
            </p>
          </section>
        ) : null}

        <section className="sidebar-panel sidebar-status">
          <div className="status-row">
            <span>Current role</span>
            <strong>{currentRole?.label || "Not selected"}</strong>
          </div>
          <div className="status-row">
            <span>Current model</span>
            <strong>{currentModel?.label || "Not selected"}</strong>
          </div>
        </section>
      </aside>

      <main className="chat-layout">
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
              <div className="chat-header-subtitle">
                {currentRole?.label || "No role"} · {currentModel?.label || "No model"}
              </div>
            </div>
          </div>
        </header>

        {error ? <div className="top-error">{error}</div> : null}

        <section className="conversation">
          {isLoading ? (
            <div className="empty-state">
              <div className="empty-state-title">Loading configuration</div>
              <div className="empty-state-copy">Fetching models and roles.</div>
            </div>
          ) : null}

          {!isLoading &&
            entries.map((entry) => (
              <div key={entry.id} className={`chat-row ${entry.role}`}>
                <div className="chat-avatar">{entry.role === "user" ? "You" : "AI"}</div>
                <div className="chat-bubble-wrap">
                  <div className="chat-bubble-header">
                    <span>{entry.role === "user" ? "You" : currentRole?.label || "Assistant"}</span>
                    {entry.meta ? <span className="chat-meta">{entry.meta}</span> : null}
                  </div>
                  <div className={`chat-bubble ${entry.role}`}>{entry.content}</div>
                </div>
              </div>
            ))}

          <div ref={messageEndRef} />
        </section>

        <footer className="composer-shell">
          <form className="composer-card" onSubmit={handleSubmit}>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder="Send a message. Enter to send, Shift+Enter for a new line."
              rows={1}
              required
            />
            <div className="composer-actions">
              <div className="composer-hint">
                Role: {currentRole?.label || "Not selected"} | Model:{" "}
                {currentModel?.label || "Not selected"}
                {currentModel?.provider === "openai"
                  ? ` | Reasoning: ${reasoningEffort}`
                  : ""}
              </div>
              <button className="send-button" type="submit" disabled={!canSubmit}>
                {isSubmitting ? "Streaming..." : "Send"}
              </button>
            </div>
          </form>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
