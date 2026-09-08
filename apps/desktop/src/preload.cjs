const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("conversationManager", Object.freeze({
  appVersion: () => ipcRenderer.invoke("app:version"),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  chatgpt: Object.freeze({
    state: () => ipcRenderer.invoke("chatgpt:state"),
    beginPairing: () => ipcRenderer.invoke("chatgpt:pair"),
    clearPairing: () => ipcRenderer.invoke("chatgpt:clear-pairing"),
    openChatGpt: () => ipcRenderer.invoke("chatgpt:open"),
    openConversation: (id) => ipcRenderer.invoke("chatgpt:open-conversation", id),
    showExtension: () => ipcRenderer.invoke("chatgpt:show-extension"),
    accounts: () => ipcRenderer.invoke("chatgpt:accounts"),
    cachedAccounts: () => ipcRenderer.invoke("chatgpt:cached-accounts"),
    cached: (accountKey, state) => ipcRenderer.invoke("chatgpt:cache", { accountKey, state }),
    list: (accountKey, label, state, full) => ipcRenderer.invoke("chatgpt:list", { accountKey, label, state, full }),
    previewDelete: (ids) => ipcRenderer.invoke("chatgpt:preview-delete", ids),
    runBatch: (accountKey, action, ids, confirmationToken) => ipcRenderer.invoke("chatgpt:batch", { accountKey, action, ids, confirmationToken }),
    cancel: () => ipcRenderer.invoke("chatgpt:cancel"),
    cacheStats: () => ipcRenderer.invoke("chatgpt:cache-stats"),
    clearCache: () => ipcRenderer.invoke("chatgpt:clear-cache")
  }),
  codex: Object.freeze({
    status: () => ipcRenderer.invoke("codex:status"),
    selectCommand: () => ipcRenderer.invoke("codex:select-command"),
    list: (params) => ipcRenderer.invoke("codex:list", params),
    open: (threadId) => ipcRenderer.invoke("codex:open", threadId),
    previewDelete: (ids) => ipcRenderer.invoke("codex:preview-delete", ids),
    runBatch: (action, ids, confirmationToken) => ipcRenderer.invoke("codex:batch", { action, ids, confirmationToken })
  }),
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke("update:get-state"), setAutoUpdate: (enabled) => ipcRenderer.invoke("update:set-auto", enabled), check: () => ipcRenderer.invoke("update:check"), install: () => ipcRenderer.invoke("update:install"), openRelease: () => ipcRenderer.invoke("update:open-release"),
    onState: (callback) => { if (typeof callback !== "function") return () => {}; const listener = (_event, state) => callback(state); ipcRenderer.on("update:state", listener); return () => ipcRenderer.removeListener("update:state", listener); }
  })
}));
