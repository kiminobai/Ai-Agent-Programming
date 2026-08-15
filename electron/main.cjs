const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const path = require("path");

// 开发环境允许从项目 .env 注入配置；安装包仍应由系统环境或部署平台注入密钥。
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SERVER_URL = "http://127.0.0.1:3000";
const SANDBOX_URL = "http://127.0.0.1:3010";
let mainWindow = null;
let serverProcess = null;
let workerProcess = null;
let sandboxProcess = null;
let serverStartupError = null;

function getWorkspaceStatePath() {
  return path.join(app.getPath("userData"), "workspaces.json");
}

function getKimiBaiDocumentsRoot() {
  return path.join(app.getPath("documents"), "KimiBai");
}

function getSandboxServiceToken() {
  const configuredToken = String(process.env.SANDBOX_SERVICE_TOKEN || "").trim();
  if (configuredToken) {
    if (configuredToken.length < 32) {
      throw new Error("SANDBOX_SERVICE_TOKEN 至少需要 32 个字符。");
    }
    return configuredToken;
  }

  const encryptedTokenPath = path.join(
    app.getPath("userData"),
    "sandbox-service-token.enc"
  );
  const legacyPlaintextPath = path.join(
    app.getPath("userData"),
    "sandbox-service.token"
  );

  if (!safeStorage.isEncryptionAvailable()) {
    // 系统密钥服务不可用时仅使用本次进程内令牌，绝不降级为明文落盘。
    fs.rmSync(legacyPlaintextPath, { force: true });
    return crypto.randomBytes(48).toString("base64url");
  }

  try {
    const token = safeStorage.decryptString(fs.readFileSync(encryptedTokenPath));
    if (token.length >= 32) return token;
  } catch {
    // 首次启动或加密数据不可读时，在下面创建新的内部令牌。
  }

  let token = "";
  try {
    // 一次性迁移旧版本留下的明文令牌，迁移成功后立即删除旧文件。
    const legacyToken = fs.readFileSync(legacyPlaintextPath, "utf8").trim();
    if (legacyToken.length >= 32) token = legacyToken;
  } catch {
    // 没有旧文件属于正常情况。
  }
  if (!token) token = crypto.randomBytes(48).toString("base64url");

  fs.mkdirSync(path.dirname(encryptedTokenPath), { recursive: true });
  const temporaryPath = `${encryptedTokenPath}.tmp`;
  fs.writeFileSync(temporaryPath, safeStorage.encryptString(token), { mode: 0o600 });
  fs.renameSync(temporaryPath, encryptedTokenPath);
  fs.rmSync(legacyPlaintextPath, { force: true });
  return token;
}

function ensureDefaultWorkspace() {
  const workspacePath = path.join(
    getKimiBaiDocumentsRoot(),
    "default-workspace"
  );
  fs.mkdirSync(workspacePath, { recursive: true });
  return toWorkspace(workspacePath);
}

function readWorkspaceState() {
  try {
    return JSON.parse(fs.readFileSync(getWorkspaceStatePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeWorkspaceState(state) {
  const statePath = getWorkspaceStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporaryPath, statePath);
}

function toWorkspace(directoryPath) {
  const realPath = fs.realpathSync.native(directoryPath);
  const stat = fs.statSync(realPath);
  if (!stat.isDirectory()) {
    throw new Error("选择的路径不是文件夹。");
  }

  let branch = "";
  try {
    const head = fs
      .readFileSync(path.join(realPath, ".git", "HEAD"), "utf8")
      .trim();
    branch = head.startsWith("ref: refs/heads/")
      ? head.slice("ref: refs/heads/".length)
      : head.slice(0, 12);
  } catch {
    branch = "";
  }

  return {
    name: path.basename(realPath),
    path: realPath,
    branch,
    selectedAt: new Date().toISOString()
  };
}

function registerWorkspaceHandlers() {
  ipcMain.handle("extensions:select-skill", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Skill 目录或 SKILL.md",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Skill", extensions: ["md"] }],
      buttonLabel: "安装这个 Skill"
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("workspace:select", async (_event, userId) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Agent 工作目录",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "选择此文件夹"
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const workspace = toWorkspace(result.filePaths[0]);
    const state = readWorkspaceState();
    state[String(userId || "guest")] = workspace;
    writeWorkspaceState(state);
    return workspace;
  });

  ipcMain.handle("workspace:get", (_event, userId) => {
    const state = readWorkspaceState();
    const workspace = state[String(userId || "guest")];
    if (!workspace) {
      const defaultWorkspace = ensureDefaultWorkspace();
      state[String(userId || "guest")] = defaultWorkspace;
      writeWorkspaceState(state);
      return defaultWorkspace;
    }

    try {
      return toWorkspace(workspace.path);
    } catch {
      const defaultWorkspace = ensureDefaultWorkspace();
      state[String(userId || "guest")] = defaultWorkspace;
      writeWorkspaceState(state);
      return defaultWorkspace;
    }
  });

  ipcMain.handle("workspace:clear", (_event, userId) => {
    const state = readWorkspaceState();
    state[String(userId || "guest")] = ensureDefaultWorkspace();
    writeWorkspaceState(state);
  });

  ipcMain.handle("workspace:reveal", async (_event, workspacePath) => {
    const workspace = toWorkspace(workspacePath);
    await shell.openPath(workspace.path);
  });
}

function isServerReady() {
  return new Promise((resolve) => {
    const request = http.get(`${SERVER_URL}/api/models`, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode < 500);
    });
    request.setTimeout(700, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverStartupError) {
      throw serverStartupError;
    }
    if (await isServerReady()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("本地服务启动超时。");
}

function isSandboxReady() {
  return new Promise((resolve) => {
    const request = http.get(`${SANDBOX_URL}/healthz`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(700, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitForSandbox() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverStartupError) throw serverStartupError;
    if (await isSandboxReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("本地 Sandbox 服务启动超时。");
}

function findSystemNodeExecutable() {
  // Electron 的 process.execPath 指向 electron.exe，它使用自己的 Node ABI。
  // Express 后端必须继续使用 npm 安装依赖时的系统 node.exe，
  // 否则 better-sqlite3 会出现 NODE_MODULE_VERSION 不一致。
  const npmNodePath = process.env.npm_node_execpath;
  if (npmNodePath && fs.existsSync(npmNodePath)) {
    return npmNodePath;
  }

  const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
  const output = execFileSync(lookupCommand, ["node"], {
    encoding: "utf8",
    windowsHide: true
  });
  const nodePath = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);

  if (!nodePath || !fs.existsSync(nodePath)) {
    throw new Error("没有找到系统 Node.js，请确认 node 命令已加入 PATH。");
  }
  return nodePath;
}

async function ensureLocalServer() {
  if (await isServerReady()) {
    return;
  }

  const serverEntry = path.join(app.getAppPath(), "dist", "server.js");
  if (!fs.existsSync(serverEntry)) {
    throw new Error("缺少 dist/server.js，请先执行 npm run build。");
  }

  serverStartupError = null;
  const nodeExecutable = findSystemNodeExecutable();
  const sandboxToken = getSandboxServiceToken();
  const sandboxEntry = path.join(app.getAppPath(), "dist", "sandbox-orchestrator", "server.js");
  if (!fs.existsSync(sandboxEntry)) {
    throw new Error("缺少 Sandbox Orchestrator，请先执行 npm run build。");
  }
  sandboxProcess = spawn(nodeExecutable, [sandboxEntry], {
    cwd: app.getAppPath(),
    env: {
      ...process.env,
      SANDBOX_ORCHESTRATOR_BACKEND: "docker",
      SANDBOX_ORCHESTRATOR_PORT: "3010",
      SANDBOX_SERVICE_TOKEN: sandboxToken,
      SANDBOX_STORAGE_ROOT: path.join(getKimiBaiDocumentsRoot(), "sandboxes"),
      SANDBOX_RUNTIME_CLASS: "docker"
    },
    stdio: "inherit",
    windowsHide: true
  });
  sandboxProcess.once("error", (error) => {
    serverStartupError = error;
  });
  sandboxProcess.once("exit", (code) => {
    if (code && code !== 0) {
      serverStartupError = new Error(`Sandbox 服务异常退出，退出码：${code}。`);
    }
  });
  await waitForSandbox();
  const sharedEnvironment = {
    ...process.env,
    KIMIBAI_WORK_DATA_ROOT: getKimiBaiDocumentsRoot(),
    KIMIBAI_EXTENSIONS_ROOT: path.join(getKimiBaiDocumentsRoot(), "extensions"),
    SANDBOX_PROVIDER: "orchestrator",
    SANDBOX_ORCHESTRATOR_URL: SANDBOX_URL,
    SANDBOX_SERVICE_TOKEN: sandboxToken,
    SANDBOX_RUNTIME_CLASS: "docker"
  };
  serverProcess = spawn(nodeExecutable, [serverEntry], {
    cwd: app.getAppPath(),
    env: sharedEnvironment,
    stdio: "inherit",
    windowsHide: true
  });
  const workerEntry = path.join(app.getAppPath(), "dist", "worker.js");
  if (!fs.existsSync(workerEntry)) {
    throw new Error("缺少 dist/worker.js，请先执行 npm run build。");
  }
  workerProcess = spawn(nodeExecutable, [workerEntry], {
    cwd: app.getAppPath(),
    env: sharedEnvironment,
    stdio: "inherit",
    windowsHide: true
  });
  serverProcess.once("error", (error) => {
    serverStartupError = error;
  });
  serverProcess.once("exit", (code) => {
    if (code && code !== 0) {
      serverStartupError = new Error(`本地服务异常退出，退出码：${code}。`);
    }
  });
  workerProcess.once("error", (error) => {
    serverStartupError = error;
  });
  workerProcess.once("exit", (code) => {
    if (code && code !== 0) {
      serverStartupError = new Error(`本地 Worker 异常退出，退出码：${code}。`);
    }
  });
  await waitForServer();
}

async function createWindow() {
  await ensureLocalServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: "#f7f7f8",
    title: "KimiBai Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await mainWindow.loadURL(SERVER_URL);
}

app.whenReady()
  .then(async () => {
    registerWorkspaceHandlers();
    await createWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("KimiBai 启动失败", message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  if (workerProcess && !workerProcess.killed) {
    workerProcess.kill();
  }
  if (sandboxProcess && !sandboxProcess.killed) {
    sandboxProcess.kill();
  }
});
