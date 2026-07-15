import React, { FormEvent, useEffect, useMemo, useState } from "react";
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
    throw new Error(`${apiName} 返回了非 JSON 内容，请确认后端已重启并加载最新代码。`);
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
      content: "已经准备好了。请选择模型与角色，然后开始对话。"
    }
  ]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

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
          availableRoles.some((item: PromptRole) => item.id === rolesData.defaultRoleId)
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

  const currentModel = useMemo(
    () => models.find((item) => item.id === modelId),
    [models, modelId]
  );

  const currentRole = useMemo(
    () => roles.find((item) => item.id === roleId),
    [roles, roleId]
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

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
      meta: `${currentModel?.provider || ""} / ${modelId} · ${currentRole?.label || roleId}`
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
            ? `${data.meta.provider} / ${data.meta.modelId} · ${currentRole?.label || data.meta.roleId}`
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

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Role Based Chat</p>
          <h1>按角色切换的 React 对话前端</h1>
          <p className="subtitle">
            选择模型，再切换系统角色。每个角色都来自独立的后端 Prompt 文件，前端通过
            React 驱动整个对话界面。
          </p>
        </div>
        <div className="hero-badge">
          <strong>当前角色</strong>
          <span>{currentRole?.label || "尚未选择"}</span>
        </div>
      </section>

      <section className="chat-card">
        {isLoading ? <div className="loading-state">正在加载模型与角色配置...</div> : null}
        {error ? <div className="error-banner">{error}</div> : null}

        <div className="topbar">
          <section className="panel">
            <h2>模型设置</h2>
            <div className="field">
              <label htmlFor="model-select">选择模型</label>
              <select
                id="model-select"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                disabled={!models.length || isLoading}
              >
                {models.length ? null : <option value="">没有可用模型</option>}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} ({model.provider})
                  </option>
                ))}
              </select>
            </div>
            <p className="meta-copy">
              {currentModel
                ? `${currentModel.label} · ${currentModel.description}`
                : "请先配置至少一个可用模型。"}
            </p>
          </section>

          <section className="panel">
            <h2>系统角色</h2>
            <div className="role-grid">
              {roles.map((role) => (
                <button
                  key={role.id}
                  type="button"
                  className={`role-card ${role.id === roleId ? "active" : ""}`}
                  onClick={() => setRoleId(role.id)}
                >
                  <div className="role-card-title">
                    <span>{role.label}</span>
                    <span className="role-chip">{role.id}</span>
                  </div>
                  <p className="role-summary">{role.summary}</p>
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="messages">
          {entries.map((entry) => (
            <article key={entry.id} className={`message ${entry.role}`}>
              <p className="message-role">{entry.role === "user" ? "你" : "助手"}</p>
              {entry.meta ? <p className="message-meta">{entry.meta}</p> : null}
              <p>{entry.content}</p>
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="输入你的问题，比如：请以当前角色身份分析这个需求。"
            required
          />
          <div className="composer-footer">
            <span className="helper-text">
              本次将使用 {currentRole?.label || "未选择角色"} 与{" "}
              {currentModel?.label || "未选择模型"} 对话。
            </span>
            <button
              className="primary-btn"
              type="submit"
              disabled={isSubmitting || !modelId || !roleId || isLoading}
            >
              {isSubmitting ? "发送中..." : "发送"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
