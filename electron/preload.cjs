const { contextBridge, ipcRenderer } = require("electron");

// Renderer 只能调用这些受控能力，不能直接访问 fs、child_process 或 Electron API。
contextBridge.exposeInMainWorld("desktopAPI", {
  platform: process.platform,
  selectWorkspace: (userId) => ipcRenderer.invoke("workspace:select", userId),
  getWorkspace: (userId) => ipcRenderer.invoke("workspace:get", userId),
  clearWorkspace: (userId) => ipcRenderer.invoke("workspace:clear", userId),
  revealWorkspace: (workspacePath) =>
    ipcRenderer.invoke("workspace:reveal", workspacePath)
});
