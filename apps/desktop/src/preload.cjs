const { contextBridge, ipcRenderer } = require("electron");

const appLanguage = ipcRenderer.sendSync("app:language-sync");

contextBridge.exposeInMainWorld("conversationManager", Object.freeze({
  appVersion: () => ipcRenderer.invoke("app:version"),
  appLanguage: appLanguage,
  setAppLanguage: (value) => ipcRenderer.invoke("language:set", value),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  chatgpt: Object.freeze({
    state: () => ipcRenderer.invoke("chatgpt:state"),
    clearPairing: () => ipcRenderer.invoke("chatgpt:clear-pairing"),
    openChatGpt: () => ipcRenderer.invoke("chatgpt:open"),
    openConversation: (id) => ipcRenderer.invoke("chatgpt:open-conversation", id),
    readConversation: (accountKey, id) => ipcRenderer.invoke("chatgpt:read-conversation", { accountKey, id }),
    showExtension: () => ipcRenderer.invoke("chatgpt:show-extension"),
    extensionDirectory: () => ipcRenderer.invoke("chatgpt:extension-directory"),
    accounts: () => ipcRenderer.invoke("chatgpt:accounts"),
    cachedAccounts: () => ipcRenderer.invoke("chatgpt:cached-accounts"),
    projects: (accountKey) => ipcRenderer.invoke("chatgpt:projects", { accountKey }),
    cached: (accountKey, state) => ipcRenderer.invoke("chatgpt:cache", { accountKey, state }),
    list: (accountKey, label, state, full) => ipcRenderer.invoke("chatgpt:list", { accountKey, label, state, full }),
    previewDelete: (ids) => ipcRenderer.invoke("chatgpt:preview-delete", ids),
    runBatch: (accountKey, action, ids, confirmationToken, projectId) => ipcRenderer.invoke("chatgpt:batch", { accountKey, action, ids, confirmationToken, projectId }),
    cancel: () => ipcRenderer.invoke("chatgpt:cancel"),
    cacheStats: () => ipcRenderer.invoke("chatgpt:cache-stats"),
      clearCache: () => ipcRenderer.invoke("chatgpt:clear-cache"),
      exportSessions: (payload) => ipcRenderer.invoke("chatgpt:export", payload)
  }),
  codex: Object.freeze({
    status: () => ipcRenderer.invoke("codex:status"),
    selectCommand: () => ipcRenderer.invoke("codex:select-command"),
    list: (params) => ipcRenderer.invoke("codex:list", params),
    read: (threadId) => ipcRenderer.invoke("codex:read-thread", { threadId }),
    projects: () => ipcRenderer.invoke("codex:projects"),
    setProject: (threadId, projectId) => ipcRenderer.invoke("codex:set-project", { threadId, projectId }),
    open: (threadId) => ipcRenderer.invoke("codex:open", threadId),
    previewDelete: (ids) => ipcRenderer.invoke("codex:preview-delete", ids),
      runBatch: (action, ids, confirmationToken) => ipcRenderer.invoke("codex:batch", { action, ids, confirmationToken }),
      exportSessions: (payload) => ipcRenderer.invoke("codex:export", payload)
  }),
  logs: Object.freeze({
    read: () => ipcRenderer.invoke("log:read"),
    clear: () => ipcRenderer.invoke("log:clear"),
    save: () => ipcRenderer.invoke("log:save"),
    info: (message) => ipcRenderer.invoke("log:info", message),
    onLine: (callback) => { if (typeof callback !== "function") return () => {}; const listener = (_event, line) => callback(line); ipcRenderer.on("log:appended", listener); return () => ipcRenderer.removeListener("log:appended", listener); }
  }),
  theme: Object.freeze({
    get: () => ipcRenderer.invoke("theme:get"),
    set: (value) => ipcRenderer.invoke("theme:set", value)
  }),
  language: Object.freeze({
    get: () => ipcRenderer.invoke("language:get"),
    set: (value) => ipcRenderer.invoke("language:set", value)
  }),
  dialog: Object.freeze({
    pickDirectory: (payload) => ipcRenderer.invoke("dialog:pick-directory", payload)
  }),
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke("update:get-state"), setAutoUpdate: (enabled) => ipcRenderer.invoke("update:set-auto", enabled), check: () => ipcRenderer.invoke("update:check"), download: () => ipcRenderer.invoke("update:download"), install: () => ipcRenderer.invoke("update:install"), openRelease: () => ipcRenderer.invoke("update:open-release"),
    onState: (callback) => { if (typeof callback !== "function") return () => {}; const listener = (_event, state) => callback(state); ipcRenderer.on("update:state", listener); return () => ipcRenderer.removeListener("update:state", listener); }
  })
}));
