(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ConversationManagerBridgeCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const ACTIVE_TASKS = new Set(["active", "scheduled", "pending", "enabled"]);
  const NON_SCHEDULED_TASK = /pro[_ -]?mode|deep[_ -]?research|image[_ -]?(?:generation|gen)|imagegen|dall[ -]?e/i;
  const PAGE_SIZE = 50; // ChatGPT 后端限制分页大小上限为 50

  class BridgeError extends Error {
    constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
  }

  function timestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
    const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? parsed : null;
  }
  function normalize(raw, state, extra = {}) {
    const id = state === "scheduled" ? (raw.conversation_id || raw.conversationId || raw.id) : (raw.id || raw.conversation_id || raw.conversationId);
    if (!id) return null;
    return {
      id: String(id), title: String(raw.title || raw.name || "未命名会话"),
      createdAt: timestamp(raw.create_time || raw.created_at || raw.createdAt),
      updatedAt: timestamp(raw.update_time || raw.updated_at || raw.updatedAt),
      state, projectId: extra.projectId || raw.project_id || undefined,
      pinned: Boolean(extra.pinned || raw.pinned_time), current: false, automation: state === "scheduled"
    };
  }
  function accountRows(payload) {
    if (payload?.accounts && !Array.isArray(payload.accounts) && typeof payload.accounts === "object") {
      const source = payload.accounts; const defaultId = source.default?.account?.account_id || null; const ordering = Array.isArray(payload.account_ordering) ? payload.account_ordering : []; const ids = [...new Set([defaultId, ...ordering, ...Object.keys(source).filter((key) => key !== "default")].filter(Boolean))];
      return ids.map((rawId, index) => { const account = (source[rawId] || (defaultId === rawId ? source.default : null))?.account || {}; return { rawId: String(rawId), label: String(account.name || (account.plan_type ? `${account.plan_type} 账号` : `账号 ${index + 1}`)), isDefault: rawId === defaultId }; });
    }
    const rows = Array.isArray(payload?.accounts) ? payload.accounts : Array.isArray(payload) ? payload : [];
    return rows.map((row) => ({ rawId: String(row.account_id || row.id || ""), label: String(row.name || row.workspace_name || row.account_name || "ChatGPT 账号"), isDefault: Boolean(row.is_default || row.default) })).filter((row) => row.rawId);
  }
  function taskRows(payload) {
    const rows = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.tasks) ? payload.tasks : Array.isArray(payload) ? payload : [];
    const result = new Map();
    for (const row of rows) {
      const status = String(row.status || row.state || "").toLowerCase(); const active = ACTIVE_TASKS.has(status) || row.is_active === true || row.enabled === true;
      const descriptors = [row.task_id, row.taskId, row.type, row.task_type, row.taskType, row.kind, row.task_kind, row.product, row.source].filter((value) => typeof value === "string").join(" ");
      if (!active || row.image_gen_message || NON_SCHEDULED_TASK.test(descriptors)) continue;
      const normalized = normalize(row, "scheduled"); if (!normalized) continue;
      const old = result.get(normalized.id); if (!old || (normalized.updatedAt || 0) > (old.updatedAt || 0)) result.set(normalized.id, normalized);
    }
    return [...result.values()];
  }
  async function digest(value) {
    const bytes = new TextEncoder().encode(value); const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  class ChatGptRepository {
    constructor(fetchImpl = fetch.bind(globalThis)) { this.fetch = fetchImpl; this.auth = null; this.controllers = new Map(); this.projects = new Map(); }
    async authenticate() {
      const sessionResponse = await this.fetch("/api/auth/session", { credentials: "include" });
      if (!sessionResponse.ok) throw await responseError(sessionResponse, "无法读取 ChatGPT 登录状态");
      const session = await sessionResponse.json(); const token = session.accessToken || session.access_token;
      if (!token) throw new BridgeError("NOT_LOGGED_IN", "请先在浏览器登录 ChatGPT");
      const response = await this.fetch(`/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=${-new Date().getTimezoneOffset()}`, { credentials: "include", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw await responseError(response, "无法读取 ChatGPT 账号");
      const rows = accountRows(await response.json()); if (!rows.length) throw new BridgeError("INCOMPATIBLE_API", "无法识别 ChatGPT 账号结构");
      this.auth = { token, rows };
      return Promise.all(rows.map(async (row) => ({ key: await digest(row.rawId), label: row.label, isDefault: row.isDefault })));
    }
    async resolveAccount(accountKey) {
      if (!this.auth) await this.authenticate();
      for (const row of this.auth.rows) if (await digest(row.rawId) === accountKey) return row;
      throw new BridgeError("INCOMPATIBLE_API", "找不到匹配的 ChatGPT 账号，请重新选择账号");
    }
    headers(accountId) { return { Authorization: `Bearer ${this.auth.token}`, "ChatGPT-Account-Id": accountId, "OAI-Language": navigator.language || "zh-CN" }; }
    async list(payload) {
      const controller = new AbortController(); this.controllers.set(payload.requestId, controller);
      try {
        const account = await this.resolveAccount(payload.accountKey); const state = payload.state || "active";
        if (state === "scheduled") return { records: await this.loadTasks(account.rawId, controller.signal), full: true };
        const records = await this.loadConversations(account.rawId, state === "archived", controller.signal, payload.mode === "incremental" ? payload.checkpoint : null);
        return { records, full: payload.mode !== "incremental", compatible: true };
      } finally { this.controllers.delete(payload.requestId); }
    }
    cancel(requestId) { this.controllers.get(requestId)?.abort(); }
    async loadTasks(accountId, signal) {
      const records = []; let offset = 0, cursor = null, previousSignature = null;
      for (;;) {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) }); if (cursor !== null) query.set("cursor", String(cursor)); else if (offset) query.set("offset", String(offset));
        const response = await this.request(`/backend-api/tasks?${query}`, accountId, { signal });
        const page = taskRows(response); records.push(...page);
        const raw = Array.isArray(response?.tasks) ? response.tasks : Array.isArray(response?.items) ? response.items : Array.isArray(response) ? response : null;
        if (!raw) throw new BridgeError("INCOMPATIBLE_API", "已安排接口结构已变化"); const signature = page.map((row) => `${row.id}:${row.updatedAt || 0}`).join("|"); if (signature && signature === previousSignature) throw new BridgeError("INCOMPATIBLE_API", "已安排接口分页没有向前推进"); previousSignature = signature;
        const next = response?.cursor ?? response?.next_cursor ?? response?.nextCursor; if (next !== undefined && next !== null && String(next) !== String(cursor)) { cursor = next; continue; }
        const total = Number(response?.total); if ((response?.has_more === true || response?.hasMore === true || (Number.isFinite(total) && offset + raw.length < total)) && raw.length) { offset += raw.length; continue; } break;
      }
      return dedupe(records);
    }
    async loadConversations(accountId, archived, signal, checkpoint) {
      const records = []; let offset = 0;
      for (;;) {
        const response = await this.request(`/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated&is_archived=${archived}`, accountId, { signal });
        const rows = Array.isArray(response?.items) ? response.items : null;
        if (!rows) throw new BridgeError("INCOMPATIBLE_API", "会话接口结构已变化");
        const page = rows.map((row) => normalize(row, archived ? "archived" : "active")).filter(Boolean); records.push(...page);
        if (checkpoint && page.length && page.every((row) => (row.updatedAt || 0) <= checkpoint)) break;
        if (rows.length < PAGE_SIZE) break; offset += rows.length;
      }
      if (!archived) {
        const discovered = new Set(); const cachedProjects = this.projects.get(accountId);
        if (checkpoint && cachedProjects && Date.now() - cachedProjects.at < 120_000) for (const id of cachedProjects.ids) discovered.add(id);
        else { let sidebarCursor = null; for (;;) { const query = new URLSearchParams({ limit: String(PAGE_SIZE), owned_only: "true", conversations_per_gizmo: "0" }); if (sidebarCursor !== null) query.set("cursor", String(sidebarCursor)); const sidebar = await this.request(`/backend-api/gizmos/snorlax/sidebar?${query}`, accountId, { signal }); for (const id of projectIds(sidebar)) discovered.add(id); const next = sidebar?.cursor ?? sidebar?.next_cursor ?? sidebar?.nextCursor; if (next === undefined || next === null || String(next) === String(sidebarCursor)) break; sidebarCursor = next; } this.projects.set(accountId, { ids: [...discovered], at: Date.now() }); }
        for (const projectId of discovered) {
          let projectCursor = 0;
          for (;;) {
            const query = new URLSearchParams({ cursor: String(projectCursor), limit: String(PAGE_SIZE), owned_only: "true" });
            const payload = await this.request(`/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?${query}`, accountId, { signal });
            const rows = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.conversations) ? payload.conversations : null;
            if (!rows) throw new BridgeError("INCOMPATIBLE_API", "项目会话接口结构已变化");
            const page = rows.filter((row) => Boolean(row?.is_archived) === archived).map((row) => normalize(row, archived ? "archived" : "active", { projectId })).filter(Boolean); records.push(...page);
            if (checkpoint && page.length && page.every((row) => (row.updatedAt || 0) <= checkpoint)) break;
            const next = payload?.cursor ?? payload?.next_cursor ?? payload?.nextCursor;
            if (next !== undefined && next !== null && String(next) !== String(projectCursor)) { projectCursor = next; continue; }
            if (payload?.has_more === true && rows.length) { projectCursor = Number(projectCursor) + rows.length; continue; }
            break;
          }
        }
      }
      if (!archived) {
        const pins = await this.request("/backend-api/pins", accountId, { signal });
        const rows = Array.isArray(pins) ? pins : null;
        if (!rows) throw new BridgeError("INCOMPATIBLE_API", "置顶会话接口结构已变化");
        records.push(...rows.map((entry) => { const raw = entry?.item && typeof entry.item === "object" ? entry.item : entry; return normalize({ ...raw, id: raw?.id || entry?.conversation_id || entry?.conversationId || entry?.item_id || entry?.itemId }, "active", { pinned: true }); }).filter(Boolean));
      }
      return dedupe(records);
    }
    async readConversation(accountId, id, signal) {
      const data = await this.request(`/backend-api/conversation/${encodeURIComponent(id)}`, accountId, { signal });
      if (!data || typeof data !== "object" || !data.mapping || typeof data.mapping !== "object") throw new BridgeError("INCOMPATIBLE_API", "会话内容接口结构已变化");
      const messages = [];
      const root = Object.keys(data.mapping).find((key) => data.mapping[key]?.parent === null) || Object.keys(data.mapping)[0];
      const visit = (nodeId, depth) => {
        if (!nodeId || depth > 1000) return;
        const node = data.mapping[nodeId]; if (!node) return;
        const message = node.message;
        if (message && message.content && !message.hidden) {
          const role = message.author?.role || "system";
          const parts = Array.isArray(message.content.parts) ? message.content.parts : [];
          const text = parts.filter((part) => typeof part === "string").join("\n").trim();
          if (text && role !== "system") messages.push({ role, at: typeof message.create_time === "number" ? message.create_time * 1000 : null, text });
        }
        (node.children || []).forEach((child) => visit(child, depth + 1));
      };
      visit(root, 0);
      return { id, title: typeof data.title === "string" ? data.title : "", messages };
    }
    async batch(payload) {
      const account = await this.resolveAccount(payload.accountKey); const action = payload.action; const ids = [...new Set(payload.ids || [])];
      if (!["archive", "restore", "delete"].includes(action) || !ids.length || ids.length > 500) throw new BridgeError("INCOMPATIBLE_API", "无效批量操作");
      const controller = new AbortController(); this.controllers.set(payload.requestId, controller); const succeeded = [], failed = []; let cursor = 0;
      try {
        const worker = async () => { while (cursor < ids.length && !controller.signal.aborted) { const id = ids[cursor++]; try { await this.mutate(account.rawId, action, id, controller.signal); succeeded.push(id); } catch (error) { if (controller.signal.aborted) break; failed.push({ id, message: error.message || String(error) }); if (error?.code === "NOT_LOGGED_IN" || error?.code === "UNAUTHORIZED") controller.abort(); } } };
        await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker)); const handled = new Set([...succeeded, ...failed.map((item) => item.id)]); return { succeeded, failed, unprocessed: ids.filter((id) => !handled.has(id)) };
      } finally { this.controllers.delete(payload.requestId); }
    }
    async mutate(accountId, action, id, signal) {
      const path = `/backend-api/conversation/${encodeURIComponent(id)}`;
      const options = { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "delete" ? { is_visible: false } : { is_archived: action === "archive" }) };
      let response;
      for (let attempt = 0; attempt < 3; attempt += 1) { response = await this.fetch(path, { ...options, signal, credentials: "include", headers: { ...options.headers, ...this.headers(accountId) } }); if (response.status !== 429 && response.status < 500) break; await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt))); }
      if (!response?.ok) { if (response?.status === 401 || response?.status === 403) this.auth = null; throw await responseError(response, "ChatGPT 操作失败"); }
      if (response.status === 204) return;
      const text = await response.text(); if (!text) throw new BridgeError("INCOMPATIBLE_API", "ChatGPT 未返回可验证的确认结果"); let body; try { body = JSON.parse(text); } catch { throw new BridgeError("INCOMPATIBLE_API", "ChatGPT 返回了无法解析的确认结果"); }
      const targetConfirmed = action === "delete" ? body?.is_visible === false : Object.prototype.hasOwnProperty.call(body || {}, "is_archived") && Boolean(body.is_archived) === (action === "archive");
      const targetConflicts = action === "delete" && Object.prototype.hasOwnProperty.call(body || {}, "is_visible") && body.is_visible !== false;
      if (targetConflicts || body?.success === false || body?.ok === false || body?.error || !(body?.success === true || body?.ok === true || targetConfirmed)) throw new BridgeError("INCOMPATIBLE_API", "ChatGPT 未确认操作成功");
    }
    async request(path, accountId, options = {}) {
      const response = await this.fetch(path, { ...options, credentials: "include", headers: { ...options.headers, ...this.headers(accountId) } });
      if (!response.ok) { if (response.status === 401 || response.status === 403) this.auth = null; throw await responseError(response, "读取 ChatGPT 数据失败"); } try { return await response.json(); } catch { throw new BridgeError("INCOMPATIBLE_API", "ChatGPT 返回结构无法解析"); }
    }
  }
  async function responseError(response, prefix) {
    const status = response?.status || 0; let detail = "";
    try {
      const body = await response.clone().json(); const value = body?.message || body?.error?.message || (typeof body?.detail === "string" ? body.detail : Array.isArray(body?.detail) ? body.detail.map((item) => item?.msg).filter(Boolean).join("；") : "");
      if (typeof value === "string") detail = value.replace(/\s+/g, " ").slice(0, 240);
    } catch {}
    return new BridgeError(status === 401 ? "NOT_LOGGED_IN" : status === 403 ? "UNAUTHORIZED" : status === 429 ? "RATE_LIMITED" : "INCOMPATIBLE_API", `${prefix} (${status || "unknown"})${detail ? `：${detail}` : ""}`, status === 429 || status >= 500);
  }
  function projectIds(payload) { const ids = new Set(); const visit = (value, depth = 0) => { if (!value || depth > 7) return; if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1)); if (typeof value !== "object") return; const id = value.id || value.gizmo_id || value.project_id; if (typeof id === "string" && id.startsWith("g-p-")) ids.add(id); Object.values(value).forEach((item) => visit(item, depth + 1)); }; visit(payload); return [...ids]; }
  function dedupe(records) { return [...new Map(records.map((row) => [row.id, row])).values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
  return Object.freeze({ ChatGptRepository, BridgeError, accountRows, taskRows, normalize, projectIds });
});
