const form = document.getElementById("chat-form");
const messageInput = document.getElementById("message");
const messages = document.getElementById("messages");
const submitButton = document.getElementById("submit-button");
const modelSelect = document.getElementById("model-select");
const modelDescription = document.getElementById("model-description");
const activeModel = document.getElementById("active-model");

let availableModels = [];

function getCurrentModel() {
  return availableModels.find((item) => item.id === modelSelect.value);
}

function renderModelDescription() {
  const currentModel = getCurrentModel();
  modelDescription.textContent = currentModel
    ? [
        `${currentModel.label} · ${currentModel.description}`,
        currentModel.enabled ? "" : `当前不可用：${currentModel.unavailableReason || "请检查配置"}`
      ]
        .filter(Boolean)
        .join(" · ")
    : "请选择一个可用模型。";

  activeModel.textContent = currentModel?.enabled
    ? `当前将调用：${currentModel.provider} / ${currentModel.id}`
    : "当前没有可用模型。";
}

async function loadModels() {
  const response = await fetch("/api/models");
  const data = await response.json();

  availableModels = (data.models || []).filter((model) => model.enabled);
  modelSelect.innerHTML = "";

  if (!availableModels.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可用模型，请先配置 API Key";
    modelSelect.appendChild(option);
    modelSelect.disabled = true;
    renderModelDescription();
    return;
  }

  availableModels.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.label} (${model.provider})`;
    modelSelect.appendChild(option);
  });

  const firstEnabledModel = availableModels[0];
  modelSelect.value = firstEnabledModel.id;
  modelSelect.disabled = false;

  renderModelDescription();
}

function appendMessage(role, content, metaText = "") {
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const roleText = document.createElement("p");
  roleText.className = "role";
  roleText.textContent = role === "user" ? "你" : "助手";

  const body = document.createElement("p");
  body.textContent = content;

  if (metaText) {
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = metaText;
    article.appendChild(roleText);
    article.appendChild(meta);
    article.appendChild(body);
  } else {
    article.appendChild(roleText);
    article.appendChild(body);
  }
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
}

modelSelect.addEventListener("change", renderModelDescription);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text || !modelSelect.value) return;
  const currentModel = getCurrentModel();

  appendMessage(
    "user",
    text,
    currentModel ? `本次发送模型：${currentModel.provider} / ${currentModel.id}` : ""
  );
  messageInput.value = "";
  submitButton.disabled = true;
  submitButton.textContent = "发送中...";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: text,
        modelId: modelSelect.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      appendMessage("assistant", data.error || "请求失败，请稍后重试。");
      return;
    }

    const metaText = data.meta
      ? `实际调用模型：${data.meta.provider} / ${data.meta.modelId}`
      : "";

    appendMessage("assistant", data.reply || "没有收到模型回复。", metaText);
  } catch (error) {
    appendMessage("assistant", `网络异常：${error.message}`);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "发送";
    messageInput.focus();
  }
});

loadModels().catch((error) => {
  appendMessage("assistant", `加载模型列表失败：${error.message}`);
});
