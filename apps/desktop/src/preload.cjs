const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cgn", Object.freeze({
  setMode: (mode) => ipcRenderer.invoke("view:set-mode", mode),
  appVersion: () => ipcRenderer.invoke("app:version"),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  codex: Object.freeze({
    list: (params) => ipcRenderer.invoke("codex:list", params),
    read: (threadId) => ipcRenderer.invoke("codex:read", threadId),
    fork: (threadId, lastTurnId) => ipcRenderer.invoke("codex:fork", { threadId, lastTurnId }),
    previewDelete: (ids) => ipcRenderer.invoke("codex:preview-delete", ids),
    runBatch: (action, ids, confirmationToken) => ipcRenderer.invoke("codex:batch", { action, ids, confirmationToken })
  })
}));
