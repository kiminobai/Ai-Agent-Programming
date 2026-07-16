import React, {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";

type ProviderId = "deepseek" | "openai" | "siliconflow";

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

async function readJsonResponse(response: Response, apiName: string) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${apiName} 返回了非 JSON 内容，请确认后端已重启并加载最新代码。`
    );
  }
}

function App() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [roles, setRoles] = useState<PromptRole[]>([]);
  const [modelId, setModelId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [message, setMessage] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "欢迎使用角色对话。先在左侧选择模型和角色，然后像 ChatGPT 一样直接开始提问。"
    }
  ]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

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
          throw new Error(modelsData.error || "加载模型失败。");
        }

        if (!rolesResponse.ok) {
          throw new Error(rolesData.error || "加载角色失败。");
        }

        const enabledModels = (modelsData.models || []).filter(
          (item: ModelOption) => item.enabled
        );
        const availableRoles = rolesData.roles || [];

        setModels(enabledModels);
        setRoles(availableRoles);
        setModelId(enabledModels[0]?.id || "");
        setRoleId(
          availableRoles.some(
            (item: PromptRole) => item.id === rolesData.defaultRoleId
          )
            ? rolesData.defaultRoleId
            : availableRoles[0]?.id || ""
        );
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : "初始化页面时发生错误。"
        );
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

  const canSubmit = Boolean(
    !isSubmitting && !isLoading && modelId && roleId && message.trim()
  );

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const trimmedMessage = message.trim();
    if (!trimmedMessage || !modelId || !roleId) {
      return;
    }

    setError("");
    setIsSubmitting(true);

    const userEntry: ChatEntry = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmedMessage,
      meta: `${currentRole?.label || roleId} · ${currentModel?.label || modelId}`
    };

    setEntries((prev) => [...prev, userEntry]);
    setMessage("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          modelId,
          roleId,
          message: trimmedMessage
        })
      });

      const data = await readJsonResponse(response, "/api/chat");
      if (!response.ok) {
        throw new Error(data.error || "请求失败，请稍后重试。");
      }

      setEntries((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: data.reply || "模型没有返回内容。",
          meta: data.meta
            ? `${currentRole?.label || data.meta.roleId} · ${data.meta.modelId}`
            : undefined
        }
      ]);
    } catch (submitError) {
      const messageText =
        submitError instanceof Error ? submitError.message : "发送消息时发生错误。";

      setError(messageText);
      setEntries((prev) => [
        ...prev,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content: `请求失败：${messageText}`
        }
      ]);
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

  return (
    <div className="chatgpt-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <div>
            <p className="sidebar-kicker">Role Chat</p>
            <h1>对话设置</h1>
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
            模型
          </label>
          <select
            id="model-select"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            disabled={!models.length || isLoading}
          >
            {models.length ? null : <option value="">没有可用模型</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <p className="sidebar-help">
            {currentModel
              ? `${currentModel.label} · ${currentModel.description}`
              : "请先配置至少一个可用模型。"}
          </p>
        </section>

        <section className="sidebar-panel">
          <div className="sidebar-label">角色</div>
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

        <section className="sidebar-panel sidebar-status">
          <div className="status-row">
            <span>当前角色</span>
            <strong>{currentRole?.label || "未选择"}</strong>
          </div>
          <div className="status-row">
            <span>当前模型</span>
            <strong>{currentModel?.label || "未选择"}</strong>
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
                {currentRole?.label || "未选择角色"} ·{" "}
                {currentModel?.label || "未选择模型"}
              </div>
            </div>
          </div>
        </header>

        {error ? <div className="top-error">{error}</div> : null}

        <section className="conversation">
          {isLoading ? (
            <div className="empty-state">
              <div className="empty-state-title">正在加载配置</div>
              <div className="empty-state-copy">正在读取模型和角色，请稍候。</div>
            </div>
          ) : null}

          {!isLoading &&
            entries.map((entry) => (
              <div key={entry.id} className={`chat-row ${entry.role}`}>
                <div className="chat-avatar">{entry.role === "user" ? "你" : "AI"}</div>
                <div className="chat-bubble-wrap">
                  <div className="chat-bubble-header">
                    <span>
                      {entry.role === "user" ? "你" : currentRole?.label || "助手"}
                    </span>
                    {entry.meta ? <span className="chat-meta">{entry.meta}</span> : null}
                  </div>
                  <div className={`chat-bubble ${entry.role}`}>{entry.content}</div>
                </div>
              </div>
            ))}

          {isSubmitting ? (
            <div className="chat-row assistant">
              <div className="chat-avatar">AI</div>
              <div className="chat-bubble-wrap">
                <div className="chat-bubble-header">
                  <span>{currentRole?.label || "助手"}</span>
                </div>
                <div className="chat-bubble assistant typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          ) : null}

          <div ref={messageEndRef} />
        </section>

        <footer className="composer-shell">
          <form className="composer-card" onSubmit={handleSubmit}>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder="给当前角色发送消息。Enter 发送，Shift + Enter 换行。"
              rows={1}
              required
            />
            <div className="composer-actions">
              <div className="composer-hint">
                角色：{currentRole?.label || "未选择"} | 模型：
                {currentModel?.label || "未选择"}
              </div>
              <button className="send-button" type="submit" disabled={!canSubmit}>
                {isSubmitting ? "发送中..." : "发送"}
              </button>
            </div>
          </form>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
