(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CGNConversationManagerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TIME_FILTER = Object.freeze({
    ALL: "all",
    DAY: "day",
    WEEK: "week",
    MONTH: "month",
    HALF_YEAR: "half-year"
  });

  function toTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 100000000000 ? value * 1000 : value;
    }
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function computeCutoff(filter, nowValue = Date.now()) {
    const now = new Date(nowValue);
    if (!Number.isFinite(now.getTime()) || filter === TIME_FILTER.ALL) return null;
    if (filter === TIME_FILTER.DAY) return now.getTime() - 24 * 60 * 60 * 1000;
    if (filter === TIME_FILTER.WEEK) return now.getTime() - 7 * 24 * 60 * 60 * 1000;
    if (filter === TIME_FILTER.MONTH || filter === TIME_FILTER.HALF_YEAR) {
      const result = new Date(now.getTime());
      const originalDate = result.getDate();
      result.setDate(1);
      result.setMonth(result.getMonth() - (filter === TIME_FILTER.MONTH ? 1 : 6));
      const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
      result.setDate(Math.min(originalDate, lastDay));
      return result.getTime();
    }
    throw new Error(`Unknown time filter: ${filter}`);
  }

  function normalizeConversation(raw, overrides = {}) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || raw.conversation_id || raw.conversationId || overrides.id || "").trim();
    if (!id) return null;
    const createdAt = toTimestamp(raw.create_time ?? raw.created_at ?? raw.createdAt);
    const updatedAt = toTimestamp(
      raw.update_time ?? raw.updated_at ?? raw.updatedAt ?? raw.latest_assistant_turn_created_at ?? raw.create_time
    );
    const titleValue = raw.title ?? raw.name ?? overrides.title;
    return {
      id,
      title: typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : "未命名聊天",
      createdAt,
      updatedAt,
      archived: overrides.archived !== undefined ? Boolean(overrides.archived) : Boolean(raw.is_archived),
      pinned: Boolean(overrides.pinned || raw.pinned_time || raw.is_pinned || raw.is_starred),
      projectId: String(overrides.projectId || raw.gizmo_id || raw.project_id || "").trim() || null,
      automation: Boolean(raw.is_automation_conversation || raw.is_automation || overrides.automation),
      temporary: Boolean(raw.is_temporary_chat || raw.temporary || overrides.temporary)
    };
  }

  function mergeConversations(collections) {
    const merged = new Map();
    for (const collection of collections || []) {
      for (const item of collection || []) {
        if (!item || !item.id) continue;
      const current = merged.get(item.id);
        if (!current) {
          merged.set(item.id, { ...item });
          continue;
        }
        const currentHasTitle = current.title && current.title !== "未命名聊天";
        const itemHasTitle = item.title && item.title !== "未命名聊天";
        const preferItemTitle = itemHasTitle && (!currentHasTitle || (item.updatedAt || 0) > (current.updatedAt || 0));
        merged.set(item.id, {
          ...current,
          ...item,
          title: preferItemTitle ? item.title : current.title,
          createdAt: current.createdAt ?? item.createdAt,
          updatedAt: Math.max(current.updatedAt || 0, item.updatedAt || 0) || null,
          pinned: Boolean(current.pinned || item.pinned),
          automation: Boolean(current.automation || item.automation),
          temporary: Boolean(current.temporary || item.temporary),
          projectId: current.projectId || item.projectId || null
        });
      }
    }
    return [...merged.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function filterConversations(records, options = {}) {
    const query = String(options.query || "").trim().toLocaleLowerCase();
    const cutoff = computeCutoff(options.timeFilter || TIME_FILTER.ALL, options.now ?? Date.now());
    return (records || []).filter((record) => {
      if (!record || record.temporary) return false;
      if (options.archiveState === "active" && record.archived) return false;
      if (options.archiveState === "archived" && !record.archived) return false;
      if (cutoff !== null && !(Number.isFinite(record.updatedAt) && record.updatedAt < cutoff)) return false;
      if (query && !String(record.title || "").toLocaleLowerCase().includes(query)) return false;
      return true;
    });
  }

  function filterConversationView(records, options = {}) {
    const view = options.view || "active";
    const archiveState = view === "archived" ? "archived" : "active";
    const filtered = filterConversations(records, { ...options, archiveState });
    if (view === "scheduled") return filtered.filter((record) => record.automation);
    if (view === "active") return filtered.filter((record) => !record.automation);
    return filtered;
  }

  function getBulkSelectableIds(records, currentConversationId) {
    return (records || [])
      .filter((record) => record && !record.pinned && !record.automation && !record.temporary && record.id !== currentConversationId)
      .map((record) => record.id);
  }

  function chooseSyncMode({ hasCache, syncedAt = 0, now = Date.now(), forceFull = false, forceIncremental = false, freshMs = 120000 } = {}) {
    if (forceFull || !hasCache) return "full";
    if (forceIncremental) return "incremental";
    return Number.isFinite(syncedAt) && now - syncedAt <= freshMs ? "validate" : "incremental";
  }

  function validateConversationPage(payload) {
    if (!payload || typeof payload !== "object") throw new Error("会话接口返回了无效数据。");
    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.conversations)
        ? payload.conversations
        : null;
    if (!items) throw new Error("会话接口结构已变化，未找到 items。");
    if (items.some((item) => !item || typeof item !== "object")) {
      throw new Error("会话接口结构已变化，列表项无效。");
    }
    return items;
  }

  return Object.freeze({
    TIME_FILTER,
    chooseSyncMode,
    computeCutoff,
    filterConversationView,
    filterConversations,
    getBulkSelectableIds,
    mergeConversations,
    normalizeConversation,
    toTimestamp,
    validateConversationPage
  });
});
