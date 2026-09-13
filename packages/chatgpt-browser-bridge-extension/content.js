(() => {
  "use strict";
  // 扩展重载/更新会把已打开页面里的旧内容脚本"孤儿化"：该隔离世界的 chrome.runtime 失效。
  // 此时任何初始化都会抛 uncaught error 并累积到扩展错误页——静默退出，等页面刷新后重生。
  if (!globalThis.chrome?.runtime?.id) return;
  if (globalThis.__conversationManagerContentBridgeLoaded) return;
  globalThis.__conversationManagerContentBridgeLoaded = true;
  const repository = new globalThis.ConversationManagerBridgeCore.ChatGptRepository();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "conversation-manager-content") return false;
    if (message.type === "ping") { sendResponse({ ok: true }); return false; }
    (async () => {
      if (message.type === "status") { const accounts = await repository.authenticate(); return { loggedIn: true, accounts, url: location.href }; }
      if (message.type === "accounts") return { accounts: await repository.authenticate() };
      if (message.type === "list") { const result = await repository.list({ ...message.payload, requestId: message.requestId }); const currentId = location.pathname.match(/\/c\/([^/?#]+)/)?.[1]; result.records = result.records.map((record) => ({ ...record, current: record.id === currentId })); return result; }
      if (message.type === "batch") return repository.batch({ ...message.payload, requestId: message.payload?.requestId || message.requestId });
      if (message.type === "projects") return { projects: await repository.listProjects(message.payload?.accountKey) };
      if (message.type === "read") return repository.readConversation(message.payload?.accountKey, message.payload?.id);
      if (message.type === "cancel") { repository.cancel(message.payload?.requestId); return { cancelled: true }; }
      throw new Error("Unsupported bridge command");
    })().then((payload) => sendResponse({ ok: true, payload }), (error) => sendResponse({ ok: false, error: { code: error.code || "INTERNAL_ERROR", message: error.message || String(error), retryable: Boolean(error.retryable) } }));
    return true;
  });
})();
