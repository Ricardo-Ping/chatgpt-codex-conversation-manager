const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cgn", Object.freeze({
  setMode: (mode) => ipcRenderer.invoke("view:set-mode", mode),
  appVersion: () => ipcRenderer.invoke("app:version"),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke("update:get-state"),
    setAutoUpdate: (enabled) => ipcRenderer.invoke("update:set-auto", enabled),
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
    openRelease: () => ipcRenderer.invoke("update:open-release"),
    onState: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("update:state", listener);
      return () => ipcRenderer.removeListener("update:state", listener);
    }
  }),
  codex: Object.freeze({
    list: (params) => ipcRenderer.invoke("codex:list", params),
    read: (threadId) => ipcRenderer.invoke("codex:read", threadId),
    fork: (threadId, lastTurnId) => ipcRenderer.invoke("codex:fork", { threadId, lastTurnId }),
    previewDelete: (ids) => ipcRenderer.invoke("codex:preview-delete", ids),
    runBatch: (action, ids, confirmationToken) => ipcRenderer.invoke("codex:batch", { action, ids, confirmationToken })
  })
}));
