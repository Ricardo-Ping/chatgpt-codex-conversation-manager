(function () {
  "use strict";

  const core = globalThis.CGNConversationManagerCore
    || (typeof module !== "undefined" && module.exports ? require("./conversation-manager-core.js") : null);
  if (!core) {
    console.error("[cgn-conversation-manager] core module is unavailable");
    return;
  }
  const indexApi = globalThis.CGNConversationIndexStore
    || (typeof module !== "undefined" && module.exports ? require("./conversation-index-store.js") : null);

  const ROOT_ID = "cgn-conversation-manager-root";
  const OPEN_EVENT = "cgn:open-conversation-manager";
  const PAGE_SIZE = 100;
  const PROJECT_PAGE_SIZE = 50;
  const MAX_PAGES = 500;
  const MAX_REQUEST_CONCURRENCY = 3;
  const INITIAL_BATCH_CONCURRENCY = 2;
  const MAX_BATCH_CONCURRENCY = 3;
  const PROJECT_DISCOVERY_TTL_MS = 5 * 60 * 1000;
  const MUTATION_JOURNAL_TTL_MS = 2 * 60 * 1000;
  const CACHE_FRESH_MS = 2 * 60 * 1000;
  const LIST_BATCH_SIZE = 100;
  const ACTIVE_SCHEDULED_STATUSES = new Set(["active", "scheduled", "pending", "enabled"]);
  const NON_SCHEDULED_TASK_PATTERN = /pro[_ -]?mode|deep[_ -]?research|image[_ -]?(?:generation|gen)|imagegen|dall[ -]?e/i;
  const VIEW_CONFIG = Object.freeze({
    active: Object.freeze({ label: "未归档", primaryAction: "archive", primaryLabel: "归档", readOnly: false }),
    archived: Object.freeze({ label: "已归档", primaryAction: "restore", primaryLabel: "恢复", readOnly: false }),
    scheduled: Object.freeze({ label: "已安排", primaryAction: null, primaryLabel: "", readOnly: true })
  });
  const TIME_FILTERS = [
    [core.TIME_FILTER.ALL, "全部"],
    [core.TIME_FILTER.DAY, "1 天前"],
    [core.TIME_FILTER.WEEK, "1 周前"],
    [core.TIME_FILTER.MONTH, "1 个月前"],
    [core.TIME_FILTER.HALF_YEAR, "半年前"]
  ];
  const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
  const SYNC_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });

  class ChatHistoryError extends Error {
    constructor(message, status = 0, fatal = false) {
      super(message);
      this.name = "ChatHistoryError";
      this.status = status;
      this.fatal = fatal;
    }
  }

  function createChatHistoryRepository({ fetchImpl = globalThis.fetch.bind(globalThis), sleep = wait, now = () => Date.now() } = {}) {
    let authContext = null;
    let activeAccountId = null;
    let mutationReady = false;
    let activeRequests = 0;
    const requestQueue = [];
    const projectDiscoveryCache = new Map();

    function runQueuedRequests() {
      while (activeRequests < MAX_REQUEST_CONCURRENCY && requestQueue.length) {
        const entry = requestQueue.shift();
        if (entry.signal?.aborted) {
          entry.reject(new DOMException("Aborted", "AbortError"));
          continue;
        }
        activeRequests += 1;
        Promise.resolve()
          .then(entry.task)
          .then(entry.resolve, entry.reject)
          .finally(() => {
            activeRequests -= 1;
            runQueuedRequests();
          });
      }
    }

    function withRequestSlot(task, signal) {
      return new Promise((resolve, reject) => {
        requestQueue.push({ task, signal, resolve, reject });
        runQueuedRequests();
      });
    }

    async function bootstrap({ accountId = null, signal } = {}) {
      mutationReady = false;
      const auth = await ensureAuth(accountId, signal);
      activeAccountId = auth.accountId;
      return { accounts: auth.accounts, accountId: auth.accountId };
    }

    async function loadAll({
      accountId = null,
      archiveState = "active",
      mode = "full",
      cachedRecords = [],
      checkpoints = {},
      signal,
      onProgress = () => {},
      onPage = () => {}
    } = {}) {
      if (!["full", "incremental", "validate"].includes(mode)) {
        throw new ChatHistoryError(`不支持的同步模式：${mode}`, 0, true);
      }
      mutationReady = false;
      const auth = await bootstrap({ accountId, signal });
      if (archiveState === "scheduled") {
        return loadScheduledView({ auth, signal, onProgress, onPage });
      }
      if (!["active", "archived"].includes(archiveState)) {
        throw new ChatHistoryError(`不支持的会话视图：${archiveState}`, 0, true);
      }
      const archived = archiveState === "archived";
      const warnings = [];
      onProgress({ phase: "list", loaded: 0, total: null, label: "正在读取聊天列表…" });

      // Start every independent active-view source immediately.  The request
      // queue still enforces one global cap, so this shortens round trips
      // without multiplying traffic or weakening the compatibility checks.
      const standardPromise = loadConversationPages({
        archived, mode, cachedRecords, checkpoint: checkpoints?.main, signal, onProgress, onPage
      });
      const activeChecks = !archived
        ? [
          loadProjectConversations({ mode, cachedRecords, checkpoints: checkpoints?.projects, signal, onProgress, onPage }),
          loadPinnedConversations(signal)
        ]
        : [];
      const sourceResults = await Promise.allSettled([standardPromise, ...activeChecks]);
      const standardCheck = sourceResults[0];
      if (standardCheck.status === "rejected") throw standardCheck.reason;
      const standardResult = standardCheck.value;
      const standard = standardResult.rows;
      let pinnedConversations = [];
      let protectionVerified = archived;
      let projectConversations = [];
      let projectCheckpoints = {};
      let pinnedIds = new Set();
      let canMutate = true;
      if (!archived) {
        const checks = sourceResults.slice(1);
        const labels = ["项目聊天", "置顶聊天"];
        for (let index = 0; index < checks.length; index += 1) {
          const check = checks[index];
          if (check.status === "rejected") {
            if (isAbortError(check.reason)) throw check.reason;
            warnings.push(`${labels[index]}读取失败：${friendlyError(check.reason)}`);
            canMutate = false;
          }
        }
        if (checks[0].status === "fulfilled") {
          projectConversations = checks[0].value.rows;
          projectCheckpoints = checks[0].value.checkpoints;
        }
        if (checks[1].status === "fulfilled") {
          pinnedConversations = checks[1].value.rows;
          pinnedIds = checks[1].value.ids;
          protectionVerified = true;
        }
        if (!canMutate) {
          warnings.push("兼容性检查未完全通过，已禁用归档、恢复和删除。请刷新页面或等待插件适配 ChatGPT 接口变化。");
        }
      }

      const normalized = [standard, pinnedConversations, projectConversations].map((items) =>
        items.map((item) => {
          const record = core.normalizeConversation(item.raw, {
            archived: item.archived,
            pinned: item.pinned || pinnedIds.has(item.id),
            projectId: item.projectId
          });
          return record;
        }).filter(Boolean)
      );

      const fetchedRecords = core.mergeConversations(normalized)
        .filter((record) => record.archived === archived);
      const cachedBase = (cachedRecords || [])
        .filter((record) => record && record.archived === archived)
        .map((record) => archived ? record : { ...record, pinned: false });
      const records = mode === "full" && (archived || canMutate)
        ? fetchedRecords
        : core.mergeConversations([cachedBase, fetchedRecords]);
      mutationReady = canMutate;
      onProgress({ phase: "done", loaded: records.length, total: records.length, label: `已读取 ${records.length} 条聊天` });
      return {
        accounts: auth.accounts,
        accountId: auth.accountId,
        records,
        warnings,
        protectionVerified,
        canMutate,
        compatible: canMutate,
        syncMode: mode,
        checkpoints: {
          main: standardResult.checkpoint,
          projects: projectCheckpoints
        }
      };
    }

    async function loadScheduledView({ auth, signal, onProgress, onPage }) {
      onProgress({ phase: "tasks", loaded: 0, total: null, label: "正在读取已安排会话…" });
      const scheduledResult = await loadScheduledTasks({
        signal,
        onProgress,
        onPage
      });
      // The tasks endpoint is a mixed task feed. Its filtered result is the authority
      // for this small read-only view, so stale v0.2.1 entries must never be merged back.
      const records = scheduledResult.records;
      onProgress({
        phase: "done",
        loaded: records.length,
        total: records.length,
        label: `已读取 ${records.length} 条已安排会话`
      });
      return {
        accounts: auth.accounts,
        accountId: auth.accountId,
        records,
        warnings: [],
        protectionVerified: true,
        canMutate: false,
        compatible: true,
        syncMode: "full",
        checkpoints: { main: scheduledResult.checkpoint, projects: {} }
      };
    }

    async function runBatch({ action, ids, signal, onProgress = () => {}, onItemResult = () => {} } = {}) {
      if (!activeAccountId) throw new ChatHistoryError("尚未选择可用账号。", 0, true);
      if (!mutationReady) throw new ChatHistoryError("兼容性检查未通过，批量操作已被安全禁用。", 0, true);
      if (!["archive", "restore", "delete"].includes(action)) {
        throw new ChatHistoryError(`不支持的批量操作：${action}`, 0, true);
      }
      const queue = [...new Set((ids || []).map(String).filter(Boolean))];
      const succeeded = [];
      const failed = [];
      let nextIndex = 0;
      let activeWorkers = 0;
      let targetConcurrency = Math.min(INITIAL_BATCH_CONCURRENCY, queue.length);
      let stableSuccesses = 0;
      let recoverySuccesses = 3;
      let fatalError = null;

      const report = () => onProgress({
        phase: "mutate",
        completed: succeeded.length + failed.length,
        total: queue.length,
        succeeded: succeeded.length,
        failed: failed.length,
        concurrency: targetConcurrency
      });
      report();

      await new Promise((resolve) => {
        const schedule = () => {
          while (activeWorkers < targetConcurrency && nextIndex < queue.length && !signal?.aborted && !fatalError) {
            const id = queue[nextIndex++];
            activeWorkers += 1;
            void process(id).finally(() => {
              activeWorkers -= 1;
              if ((nextIndex >= queue.length || signal?.aborted || fatalError) && activeWorkers === 0) resolve();
              else schedule();
            });
          }
          if ((nextIndex >= queue.length || signal?.aborted || fatalError) && activeWorkers === 0) resolve();
        };

        async function process(id) {
          try {
            await mutateConversation(action, id, signal, {
              onRateLimit() {
                // Do not start more work after a 429.  In-flight requests are
                // allowed to finish, then the batch continues one at a time.
                targetConcurrency = 1;
                stableSuccesses = 0;
                recoverySuccesses = 0;
              }
            });
            succeeded.push(id);
            if (recoverySuccesses < 3) {
              recoverySuccesses += 1;
            } else {
              stableSuccesses += 1;
              if (targetConcurrency < MAX_BATCH_CONCURRENCY && stableSuccesses >= targetConcurrency) {
                targetConcurrency += 1;
                stableSuccesses = 0;
              }
            }
            onItemResult({ id, status: "succeeded", action });
          } catch (error) {
            if (!isAbortError(error)) {
              const failure = { id, message: friendlyError(error) };
              failed.push(failure);
              onItemResult({ ...failure, status: "failed", action });
              if (error && error.fatal) fatalError = error;
            }
          }
          report();
        }
        schedule();
      }
      );
      const finished = new Set([...succeeded, ...failed.map((item) => item.id)]);
      const unprocessed = queue.filter((id) => !finished.has(id));
      return { succeeded, failed, unprocessed, fatalError: fatalError ? friendlyError(fatalError) : null };
    }

    async function ensureAuth(requestedAccountId, signal) {
      if (!authContext) {
        const sessionResponse = await fetchImpl("/api/auth/session", { credentials: "include", signal });
        if (!sessionResponse.ok) throw responseError(sessionResponse, "无法读取 ChatGPT 登录会话");
        const session = await readJson(sessionResponse, "登录会话");
        const accessToken = session.accessToken || session.access_token;
        if (!accessToken || typeof accessToken !== "string") {
          throw new ChatHistoryError("没有取得临时访问凭据，请重新登录或刷新 ChatGPT。", 401, true);
        }

        const timezoneOffset = -new Date().getTimezoneOffset();
        const accountsResponse = await fetchImpl(
          `/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=${encodeURIComponent(timezoneOffset)}`,
          {
            credentials: "include",
            signal,
            headers: { Authorization: `Bearer ${accessToken}`, "OAI-Language": globalThis.navigator?.language || "zh-CN" }
          }
        );
        if (!accountsResponse.ok) throw responseError(accountsResponse, "无法读取 ChatGPT 账号");
        const accountsPayload = await readJson(accountsResponse, "账号信息");
        const accounts = normalizeAccounts(accountsPayload);
        if (!accounts.length) throw new ChatHistoryError("没有找到可管理的 ChatGPT 账号。", 0, true);
        authContext = { accessToken, accounts };
      }

      const chosen = requestedAccountId
        ? authContext.accounts.find((account) => account.id === requestedAccountId)
        : authContext.accounts.find((account) => account.isDefault) || authContext.accounts[0];
      if (!chosen) throw new ChatHistoryError("所选账号已不可用，请重新打开会话管理。", 0, true);
      return { ...authContext, accountId: chosen.id };
    }

    function normalizeAccounts(payload) {
      const source = payload && payload.accounts && typeof payload.accounts === "object" ? payload.accounts : {};
      const defaultId = source.default?.account?.account_id || null;
      const ordering = Array.isArray(payload?.account_ordering) ? payload.account_ordering : [];
      const ids = [...ordering, ...Object.keys(source).filter((key) => key !== "default")];
      if (defaultId) ids.unshift(defaultId);
      const uniqueIds = [...new Set(ids.filter(Boolean))];
      return uniqueIds.map((id, index) => {
        const entry = source[id] || (source.default?.account?.account_id === id ? source.default : null);
        const account = entry?.account || {};
        const plan = String(account.plan_type || "").trim();
        const name = String(account.name || "").trim();
        return {
          id,
          label: name || (plan ? `${plan} 账号` : `账号 ${index + 1}`),
          isDefault: id === defaultId
        };
      });
    }

    async function loadConversationPages({ archived, mode, cachedRecords, checkpoint, signal, onProgress, onPage }) {
      const rows = [];
      const cached = new Map((cachedRecords || []).map((record) => [record.id, record]));
      let offset = 0;
      let expectedTotal = null;
      let latestTimestamp = mode === "full" || !Number.isFinite(checkpoint) ? null : checkpoint;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({
          offset: String(offset),
          limit: String(PAGE_SIZE),
          order: "updated",
          is_archived: String(Boolean(archived))
        });
        const payload = await requestJson(`/backend-api/conversations?${query}`, { signal });
        const items = core.validateConversationPage(payload);
        expectedTotal = Number.isFinite(Number(payload.total)) ? Number(payload.total) : expectedTotal;
        for (const raw of items) {
          const id = String(raw.id || raw.conversation_id || "");
          if (id) rows.push({ id, raw, archived: Boolean(archived), pinned: Boolean(raw.pinned_time || raw.is_pinned) });
        }
        const pageRecords = rows.slice(rows.length - items.length)
          .map((item) => core.normalizeConversation(item.raw, { archived: item.archived, pinned: item.pinned }))
          .filter(Boolean);
        latestTimestamp = maxTimestamp(pageRecords, latestTimestamp);
        onPage({ scope: "main", records: pageRecords, checkpoint: latestTimestamp });
        offset += items.length;
        onProgress({
          phase: "list",
          loaded: rows.length,
          total: expectedTotal,
          label: archived ? "正在读取已归档聊天…" : "正在读取聊天列表…"
        });
        const unchangedPage = pageRecords.length > 0 && pageRecords.every((record) => {
          const previous = cached.get(record.id);
          return previous && previous.updatedAt === record.updatedAt;
        });
        if (mode === "validate" || (mode === "incremental" && unchangedPage)) break;
        if (!items.length || (expectedTotal !== null && offset >= expectedTotal)) break;
      }
      return { rows, checkpoint: latestTimestamp };
    }

    async function loadScheduledTasks({ signal, onProgress, onPage }) {
      const records = [];
      let cursor = null;
      let offset = 0;
      let expectedTotal = null;
      let latestTimestamp = null;
      let previousPageSignature = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (cursor !== null) query.set("cursor", String(cursor));
        else if (offset > 0) query.set("offset", String(offset));
        const payload = await requestJson(`/backend-api/tasks?${query}`, { signal });
        const tasks = validateScheduledTasks(payload);
        expectedTotal = Number.isFinite(Number(payload.total)) ? Number(payload.total) : expectedTotal;
        const pageRecords = tasks.filter(isActiveScheduledTask).map(normalizeScheduledTask);
        const pageSignature = pageRecords.map((record) => `${record.id}:${record.updatedAt || 0}`).join("|");
        if (page > 0 && pageSignature && pageSignature === previousPageSignature) {
          throw new ChatHistoryError("已安排接口分页没有向前推进，已安全停止同步。", 0, true);
        }
        previousPageSignature = pageSignature;
        for (const record of pageRecords) {
          records.push(record);
        }
        const uniqueCount = new Set(records.map((record) => record.id)).size;
        latestTimestamp = maxTimestamp(pageRecords, latestTimestamp);
        onPage({ scope: "scheduled", records: pageRecords, checkpoint: latestTimestamp });
        onProgress({
          phase: "tasks",
          loaded: uniqueCount,
          total: expectedTotal,
          label: expectedTotal === null
            ? `正在读取已安排会话 · ${uniqueCount} 条…`
            : `正在读取已安排会话 · 已识别 ${uniqueCount} 条活动提醒…`
        });

        const nextCursor = payload.cursor ?? payload.next_cursor ?? payload.nextCursor;
        if (nextCursor !== undefined && nextCursor !== null && String(nextCursor) !== String(cursor)) {
          cursor = nextCursor;
          continue;
        }
        const hasMore = payload.has_more === true || payload.hasMore === true
          || (expectedTotal !== null && offset + tasks.length < expectedTotal);
        if (hasMore && tasks.length) {
          offset += tasks.length;
          continue;
        }
        break;
      }
      return { records: core.mergeConversations([records]), checkpoint: latestTimestamp };
    }

    function validateScheduledTasks(payload) {
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.tasks)) {
        throw new ChatHistoryError("已安排接口结构已变化，未找到 tasks 列表。", 0, true);
      }
      if (payload.tasks.some((task) => !task || typeof task !== "object")) {
        throw new ChatHistoryError("已安排接口结构已变化，任务项无效。", 0, true);
      }
      return payload.tasks;
    }

    function normalizeScheduledTask(task) {
      const conversationId = String(task.conversation_id || task.conversationId || "").trim();
      const taskId = String(task.task_id || task.taskId || task.id || "").trim();
      const id = conversationId || (taskId ? `task:${taskId}` : "");
      if (!id) throw new ChatHistoryError("已安排接口结构已变化，任务缺少标识。", 0, true);
      const title = typeof task.title === "string" && task.title.trim() ? task.title.trim() : "未命名定时任务";
      return core.normalizeConversation({ ...task, id, title }, {
        archived: false,
        pinned: false,
        automation: true
      });
    }

    function isActiveScheduledTask(task) {
      const status = String(task.status ?? task.state ?? "").trim().toLowerCase();
      const explicitlyActive = ACTIVE_SCHEDULED_STATUSES.has(status)
        || task.is_active === true
        || task.enabled === true;
      if (!explicitlyActive) return false;
      const descriptors = [
        task.task_id,
        task.taskId,
        task.type,
        task.task_type,
        task.taskType,
        task.kind,
        task.task_kind,
        task.product,
        task.source
      ].filter((value) => typeof value === "string").join(" ");
      return !task.image_gen_message && !NON_SCHEDULED_TASK_PATTERN.test(descriptors);
    }

    async function loadProjectConversations({ mode, cachedRecords, checkpoints = {}, signal, onProgress, onPage }) {
      const projects = await loadProjectIds(signal);
      let completedProjects = 0;
      const nextCheckpoints = {};
      const projectRows = await mapWithConcurrency(projects, 3, async (projectId) => {
        const results = [];
        const cached = new Map((cachedRecords || [])
          .filter((record) => record.projectId === projectId)
          .map((record) => [record.id, record]));
        let cursor = 0;
        const previousCheckpoint = checkpoints?.[projectId];
        let latestTimestamp = mode === "full" || !Number.isFinite(previousCheckpoint) ? null : previousCheckpoint;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const query = new URLSearchParams({ cursor: String(cursor), limit: String(PROJECT_PAGE_SIZE), owned_only: "true" });
          const pagePayload = await requestJson(
            `/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?${query}`,
            { signal }
          );
          const items = core.validateConversationPage(pagePayload);
          for (const raw of items) {
            const id = String(raw.id || raw.conversation_id || "");
            if (id) results.push({ id, raw, archived: Boolean(raw.is_archived), pinned: Boolean(raw.pinned_time), projectId });
          }
          const pageRecords = results.slice(results.length - items.length)
            .map((item) => core.normalizeConversation(item.raw, {
              archived: item.archived,
              pinned: item.pinned,
              projectId
            }))
            .filter(Boolean);
          latestTimestamp = maxTimestamp(pageRecords, latestTimestamp);
          onPage({ scope: "project", projectId, records: pageRecords, checkpoint: latestTimestamp });
          const unchangedPage = pageRecords.length > 0 && pageRecords.every((record) => {
            const previous = cached.get(record.id);
            return previous && previous.updatedAt === record.updatedAt;
          });
          if (mode === "validate" || (mode === "incremental" && unchangedPage)) break;
          const nextCursor = pagePayload.cursor ?? pagePayload.next_cursor ?? pagePayload.nextCursor;
          if (nextCursor !== undefined && nextCursor !== null && String(nextCursor) !== String(cursor)) {
            cursor = nextCursor;
            continue;
          }
          if (pagePayload.has_more === true && items.length) {
            cursor = Number(cursor) + items.length;
            continue;
          }
          break;
        }
        nextCheckpoints[projectId] = latestTimestamp || 0;
        completedProjects += 1;
        onProgress({
          phase: "projects",
          loaded: completedProjects,
          total: projects.length,
          label: `正在读取项目聊天 ${completedProjects}/${projects.length}…`
        });
        return results;
      });
      return { rows: projectRows.flat(), checkpoints: nextCheckpoints };
    }

    async function loadProjectIds(signal) {
      const cached = projectDiscoveryCache.get(activeAccountId);
      if (cached && cached.expiresAt > now()) return [...cached.ids];
      const projects = [];
      let cursor = null;
      let offset = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({
          owned_only: "true",
          conversations_per_gizmo: "0",
          limit: String(PROJECT_PAGE_SIZE)
        });
        if (cursor !== null) query.set("cursor", String(cursor));
        else if (offset > 0) query.set("offset", String(offset));
        const payload = await requestJson(`/backend-api/gizmos/snorlax/sidebar?${query}`, { signal });
        validateProjectSidebar(payload);
        const pageProjects = extractProjects(payload);
        projects.push(...pageProjects);
        const nextCursor = payload.cursor ?? payload.next_cursor ?? payload.nextCursor;
        if (nextCursor !== undefined && nextCursor !== null && String(nextCursor) !== String(cursor)) {
          cursor = nextCursor;
          continue;
        }
        const hasMore = payload.has_more === true || payload.hasMore === true;
        if (hasMore && pageProjects.length) {
          offset += pageProjects.length;
          continue;
        }
        break;
      }
      const ids = [...new Set(projects)];
      projectDiscoveryCache.set(activeAccountId, { ids, expiresAt: now() + PROJECT_DISCOVERY_TTL_MS });
      return ids;
    }

    function validateProjectSidebar(payload) {
      if (!payload || typeof payload !== "object") {
        throw new ChatHistoryError("项目接口返回了无效数据。", 0, true);
      }
      const recognized = ["items", "gizmos", "projects", "data", "sidebar"].some((key) =>
        Array.isArray(payload[key]) || (payload[key] && typeof payload[key] === "object")
      );
      if (!recognized) throw new ChatHistoryError("项目接口结构已变化，未找到项目列表。", 0, true);
    }

    function extractProjects(payload) {
      const candidates = [];
      const visit = (value, depth = 0) => {
        if (!value || depth > 4) return;
        if (Array.isArray(value)) {
          value.forEach((item) => visit(item, depth + 1));
          return;
        }
        if (typeof value !== "object") return;
        const id = value.id || value.gizmo_id || value.gizmo?.id || value.gizmo?.gizmo?.id;
        if (typeof id === "string" && /^g-p-/.test(id)) candidates.push(id);
        for (const key of ["items", "gizmos", "projects", "data", "sidebar"]) visit(value[key], depth + 1);
      };
      visit(payload);
      return [...new Set(candidates)];
    }

    async function loadPinnedConversations(signal) {
      const payload = await requestJson("/backend-api/pins", { signal });
      if (!Array.isArray(payload)) {
        throw new ChatHistoryError("置顶接口结构已变化，预期返回数组。", 0, true);
      }
      const ids = new Set();
      const rows = [];
      for (const entry of payload) {
        if (!entry || typeof entry !== "object") {
          throw new ChatHistoryError("置顶接口结构已变化，列表项无效。", 0, true);
        }
        const type = String(entry.item_type || entry.type || entry.object_type || "").toLowerCase();
        if (type && !type.includes("conversation") && !type.includes("chat")) continue;
        const raw = entry.item && typeof entry.item === "object" ? entry.item : entry;
        const id = String(raw.id || entry.conversation_id || entry.conversationId || entry.item_id || entry.itemId || "").trim();
        if (!id) continue;
        ids.add(id);
        rows.push({ id, raw, archived: Boolean(raw.is_archived), pinned: true });
      }
      return { ids, rows };
    }

    async function mutateConversation(action, id, signal, { onRateLimit = () => {} } = {}) {
      const path = `/backend-api/conversation/${encodeURIComponent(id)}`;
      const method = "PATCH";
      const body = JSON.stringify(action === "delete"
        ? { is_visible: false }
        : { is_archived: action === "archive" });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await requestRaw(path, { method, body, signal });
        if (response.ok) {
          if (action === "delete") await validateMutationResponse(response, action);
          return;
        }
        if (response.status === 401 || response.status === 403) {
          authContext = null;
          throw new ChatHistoryError("登录状态已失效，已停止后续操作。", response.status, true);
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          if (response.status === 429) onRateLimit();
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : [600, 1500][attempt];
          await sleep(delay, signal);
          continue;
        }
        throw responseError(response, `${actionLabel(action)}失败`);
      }
    }

    async function validateMutationResponse(response, action) {
      if (response.status === 204) return;
      const contentType = String(response.headers?.get("content-type") || "").toLowerCase();
      if (!contentType.includes("json")) {
        throw new ChatHistoryError(`${actionLabel(action)}失败：服务器未返回可验证的确认结果。`, response.status);
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new ChatHistoryError(`${actionLabel(action)}失败：服务器返回了无法解析的确认结果。`, response.status);
      }
      const targetStateConfirmed = action === "delete"
        ? payload?.is_visible === false
        : Object.prototype.hasOwnProperty.call(payload || {}, "is_archived")
          && Boolean(payload.is_archived) === (action === "archive");
      const targetStateConflicts = action === "delete"
        && Object.prototype.hasOwnProperty.call(payload || {}, "is_visible")
        && payload.is_visible !== false;
      const confirmed = payload?.success === true || payload?.ok === true || targetStateConfirmed;
      if (targetStateConflicts || !confirmed || payload?.success === false || payload?.ok === false || Boolean(payload?.error)) {
        throw new ChatHistoryError(`${actionLabel(action)}失败：服务器未确认${actionLabel(action)}结果。`, response.status);
      }
    }

    async function requestJson(path, options = {}) {
      const response = await requestRaw(path, options);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) authContext = null;
        throw responseError(response, "读取 ChatGPT 数据失败");
      }
      return readJson(response, "ChatGPT 数据");
    }

    async function requestRaw(path, { method = "GET", body, signal } = {}) {
      const auth = await ensureAuth(activeAccountId, signal);
      const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "ChatGPT-Account-Id": auth.accountId,
        "OAI-Language": globalThis.navigator?.language || "zh-CN"
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return withRequestSlot(
        () => fetchImpl(path, { method, body, signal, credentials: "include", headers }),
        signal
      );
    }

    return Object.freeze({ bootstrap, loadAll, runBatch });
  }

  function maxTimestamp(records, fallback = null) {
    let result = Number.isFinite(fallback) ? fallback : null;
    for (const record of records || []) {
      if (Number.isFinite(record?.updatedAt)) result = Math.max(result || 0, record.updatedAt);
    }
    return result;
  }

  function responseError(response, prefix) {
    const status = Number(response?.status || 0);
    const fatal = status === 401 || status === 403;
    return new ChatHistoryError(`${prefix}（HTTP ${status || "未知"}）`, status, fatal);
  }

  async function readJson(response, label) {
    try {
      return await response.json();
    } catch {
      throw new ChatHistoryError(`${label}返回了无法解析的数据。`, Number(response?.status || 0), true);
    }
  }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (!signal) return;
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  async function mapWithConcurrency(items, concurrency, worker) {
    const values = new Array(items.length);
    let nextIndex = 0;
    async function run() {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        values[index] = await worker(items[index], index);
      }
    }
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => run()));
    return values;
  }

  function isAbortError(error) {
    return error && (error.name === "AbortError" || /aborted/i.test(String(error.message || error)));
  }

  function friendlyError(error) {
    if (isAbortError(error)) return "操作已停止";
    return String(error?.message || error || "未知错误");
  }

  function actionLabel(action) {
    return action === "archive" ? "归档" : action === "restore" ? "恢复" : "删除";
  }

  function conversationRecordsEqual(first, second) {
    if (first === second) return true;
    if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return false;
    const fields = ["id", "title", "createdAt", "updatedAt", "archived", "pinned", "projectId", "automation", "temporary"];
    return first.every((record, index) => fields.every((field) => record?.[field] === second[index]?.[field]));
  }

  function applyConfirmedBatchItem(records, selected, item) {
    const nextSelected = new Set(selected || []);
    if (!item || item.status !== "succeeded" || !item.id) {
      return { records: Array.isArray(records) ? records : [], selected: nextSelected };
    }
    nextSelected.delete(item.id);
    return {
      records: (records || []).filter((record) => record.id !== item.id),
      selected: nextSelected
    };
  }

  function createThrottledUpdater(callback, {
    interval = 100,
    now = () => Date.now(),
    schedule = (task, delay) => setTimeout(task, delay),
    cancelSchedule = (timer) => clearTimeout(timer)
  } = {}) {
    let lastRun = -Infinity;
    let timer = null;
    let pending;
    const deliver = () => {
      timer = null;
      lastRun = now();
      const value = pending;
      pending = undefined;
      callback(value);
    };
    return Object.freeze({
      push(value) {
        pending = value;
        const remaining = interval - (now() - lastRun);
        if (remaining <= 0) {
          if (timer !== null) cancelSchedule(timer);
          deliver();
        } else if (timer === null) {
          timer = schedule(deliver, remaining);
        }
      },
      flush() {
        if (timer !== null) cancelSchedule(timer);
        if (pending !== undefined) deliver();
      },
      cancel() {
        if (timer !== null) cancelSchedule(timer);
        timer = null;
        pending = undefined;
      }
    });
  }

  // Keeps authentication, account-scoped cache hydration, record merging and
  // deferred mutation writes in one place.  The UI only owns presentation
  // state, which makes a reopened manager reuse its already-verified view
  // instead of rebuilding it from storage every time.
  function createConversationSyncEngine({ repository, indexStore, now = () => Date.now(), freshMs = CACHE_FRESH_MS, schedule = setTimeout, cancelSchedule = clearTimeout } = {}) {
    if (!repository) throw new Error("ConversationSyncEngine requires a repository.");
    const snapshots = new Map();
    const generations = new Map();
    const accountWrites = new Map();
    const pendingMutations = new Map();
    const mutationJournal = new Map();

    async function load({ accountId, view, forceFull = false, forceIncremental = false, signal, onAuthenticated = () => {}, onCached = () => {}, onProgress = () => {}, onPage = () => {} } = {}) {
      const auth = await repository.bootstrap({ accountId, signal });
      // A locally confirmed operation has priority over a just-started list
      // request.  Drain it before reading the persisted base for this sync.
      await flushMutations(auth.accountId);
      const viewKey = `${auth.accountId}:${view}`;
      const generation = advanceGeneration(viewKey);
      onAuthenticated(auth);
      const snapshot = snapshots.get(viewKey);
      if (snapshot) onCached(snapshot, { memory: true });

      let cached = snapshot || null;
      let cacheError = null;
      if (indexStore) {
        try {
          const persisted = await indexStore.read(auth.accountId, view);
          if (persisted) {
            cached = persisted;
            snapshots.set(viewKey, persisted);
            onCached(persisted, { memory: false });
          }
        } catch (error) {
          cacheError = error;
        }
      }
      if (!isCurrent(viewKey, generation)) return { stale: true };
      const selectedMode = core.chooseSyncMode({
        hasCache: Boolean(cached), syncedAt: cached?.syncedAt, now: now(), forceFull, forceIncremental, freshMs
      });
      const mode = view === "scheduled" ? "full" : selectedMode;
      const streamed = new Map((cached?.records || []).map((record) => [
        record.id, view === "active" ? { ...record, pinned: false } : record
      ]));
      const result = await repository.loadAll({
        accountId: auth.accountId,
        archiveState: view,
        mode,
        cachedRecords: cached?.records || [],
        checkpoints: cached?.checkpoints || {},
        signal,
        onProgress,
        onPage(page) {
          for (const record of page.records || []) streamed.set(record.id, record);
          onPage(page);
        }
      });
      if (!isCurrent(viewKey, generation)) return { stale: true };
      const records = mode === "full" || view === "scheduled"
        ? result.records
        : core.mergeConversations([[...streamed.values()], result.records]);
      const journalledRecords = applyMutationJournal(auth.accountId, view, records);
      const syncedAt = now();
      let writeError = null;
      if (indexStore && result.compatible) {
        try {
          await enqueueAccountWrite(result.accountId, async () => {
            if (!isCurrent(viewKey, generation)) return;
            await indexStore.write(result.accountId, view, {
              records: journalledRecords,
              syncedAt,
              fullSyncedAt: mode === "full" ? syncedAt : (cached?.fullSyncedAt || 0),
              checkpoints: result.checkpoints
            });
          });
        } catch (error) {
          writeError = error;
        }
      }
      if (!isCurrent(viewKey, generation)) return { stale: true };
      if (result.compatible) {
        snapshots.set(viewKey, {
          records: journalledRecords,
          syncedAt,
          fullSyncedAt: mode === "full" ? syncedAt : (cached?.fullSyncedAt || 0),
          checkpoints: result.checkpoints
        });
      }
      return { auth, cached, cacheError, writeError, mode, records: journalledRecords, result, syncedAt };
    }

    function queueMutation({ accountId, action, id, record, onError = () => {} } = {}) {
      if (!accountId || !id || !record) return;
      patchSnapshots(accountId, action, id, record);
      rememberMutation(accountId, action, id, record);
      if (!indexStore) return;
      const pending = pendingMutations.get(accountId) || { operations: [], timer: null, onError };
      pending.operations.push({ action, succeeded: [id], records: [record] });
      pending.onError = onError;
      pendingMutations.set(accountId, pending);
      if (pending.timer === null) pending.timer = schedule(() => { void flushMutations(accountId); }, 150);
    }

    function advanceGeneration(viewKey) {
      const next = (generations.get(viewKey) || 0) + 1;
      generations.set(viewKey, next);
      return next;
    }

    function isCurrent(viewKey, generation) {
      return generations.get(viewKey) === generation;
    }

    function enqueueAccountWrite(accountId, task) {
      const previous = accountWrites.get(accountId) || Promise.resolve();
      const next = previous.catch(() => {}).then(task);
      accountWrites.set(accountId, next);
      return next;
    }

    function rememberMutation(accountId, action, id, record) {
      const journal = mutationJournal.get(accountId) || new Map();
      // The journal bridges the short eventual-consistency window after a
      // confirmed PATCH. It must expire so a later full calibration can again
      // reflect authoritative changes made on another device.
      journal.set(id, { action, record: { ...record }, expiresAt: now() + MUTATION_JOURNAL_TTL_MS });
      mutationJournal.set(accountId, journal);
      advanceGeneration(`${accountId}:active`);
      advanceGeneration(`${accountId}:archived`);
    }

    function applyMutationJournal(accountId, view, records) {
      const journal = mutationJournal.get(accountId);
      if (!journal?.size || view === "scheduled") return records;
      const byId = new Map((records || []).map((record) => [record.id, record]));
      for (const [id, mutation] of journal) {
        if (!Number.isFinite(mutation.expiresAt) || mutation.expiresAt <= now()) {
          journal.delete(id);
          continue;
        }
        if (mutation.action === "delete") byId.delete(id);
        else if (mutation.action === "archive") {
          if (view === "active") byId.delete(id);
          else byId.set(id, { ...mutation.record, archived: true });
        } else if (mutation.action === "restore") {
          if (view === "archived") byId.delete(id);
          else byId.set(id, { ...mutation.record, archived: false });
        }
      }
      if (!journal.size) mutationJournal.delete(accountId);
      return core.mergeConversations([[...byId.values()]]);
    }

    function patchSnapshots(accountId, action, id, record) {
      const activeKey = `${accountId}:active`;
      const archivedKey = `${accountId}:archived`;
      const active = snapshots.get(activeKey);
      const archived = snapshots.get(archivedKey);
      const remove = (snapshot) => snapshot && { ...snapshot, records: snapshot.records.filter((item) => item.id !== id), syncedAt: now() };
      const nextActive = remove(active);
      const nextArchived = remove(archived);
      if (nextActive) snapshots.set(activeKey, nextActive);
      if (nextArchived) snapshots.set(archivedKey, nextArchived);
      if (action === "archive" && nextArchived) {
        snapshots.set(archivedKey, {
          ...nextArchived,
          records: core.mergeConversations([nextArchived.records, [{ ...record, archived: true }]])
        });
      }
      if (action === "restore" && nextActive) {
        snapshots.set(activeKey, {
          ...nextActive,
          records: core.mergeConversations([nextActive.records, [{ ...record, archived: false }]])
        });
      }
    }

    async function flushMutations(accountId) {
      const pending = pendingMutations.get(accountId);
      if (!pending?.operations.length) {
        await accountWrites.get(accountId);
        return;
      }
      if (pending.timer !== null) cancelSchedule(pending.timer);
      pendingMutations.delete(accountId);
      try {
        await enqueueAccountWrite(accountId, () => indexStore.applyBatches(accountId, pending.operations));
      } catch (error) {
        pending.onError(error);
      }
    }

    return Object.freeze({ flushMutations, load, queueMutation });
  }

  function currentConversationId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createButton(text, className, onClick) {
    const button = createElement("button", className, text);
    button.type = "button";
    if (onClick) button.addEventListener("click", onClick);
    return button;
  }

  function formatDate(timestamp) {
    if (!Number.isFinite(timestamp)) return "时间未知";
    return DATE_FORMATTER.format(new Date(timestamp));
  }

  function getEmptyStateLabel({ loading = false, query = "", view = "active" } = {}) {
    if (loading) return view === "scheduled" ? "正在读取已安排会话…" : "正在读取聊天…";
    if (query) return view === "scheduled" ? "没有匹配的已安排会话。" : "没有匹配的聊天。";
    return view === "scheduled" ? "当前条件下没有已安排会话。" : "当前条件下没有聊天。";
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Object.freeze({
      ChatHistoryError,
      applyConfirmedBatchItem,
      createChatHistoryRepository,
      createConversationSyncEngine,
      createThrottledUpdater,
      conversationRecordsEqual,
      getEmptyStateLabel
    });
  }
  if (typeof document === "undefined") return;

  const repository = createChatHistoryRepository();
  const memoryStorage = {};
  const storageAdapter = createStorageAdapter();
  const indexStore = indexApi ? indexApi.createConversationIndexStore({ storage: storageAdapter }) : null;
  const syncEngine = createConversationSyncEngine({ repository, indexStore });
  const state = {
    open: false,
    view: "active",
    timeFilter: core.TIME_FILTER.ALL,
    query: "",
    records: [],
    recordById: new Map(),
    filteredRecords: [],
    renderedCount: 0,
    selected: new Set(),
    accounts: [],
    accountId: null,
    loadedViewKey: "",
    loading: false,
    running: false,
    progress: null,
    syncMessage: "",
    cacheSyncedAt: 0,
    warnings: [],
    cacheWarning: "",
    error: "",
    result: "",
    confirmDelete: false,
    protectionVerified: false,
    canMutate: false,
    loadController: null,
    batchController: null
  };
  let ui = null;
  let previouslyFocusedElement = null;
  let searchTimer = null;

  function setRecords(records) {
    state.records = Array.isArray(records) ? records : [];
    state.recordById = new Map(state.records.map((record) => [record.id, record]));
  }

  function createStorageAdapter() {
    const local = globalThis.chrome?.storage?.local;
    if (!local) {
      return {
        async get(key) { return { [key]: structuredClone(memoryStorage[key]) }; },
        async set(entries) { Object.assign(memoryStorage, structuredClone(entries)); }
      };
    }
    return {
      get(key) {
        return new Promise((resolve, reject) => {
          local.get(key, (value) => {
            const error = globalThis.chrome?.runtime?.lastError;
            if (error) reject(new Error(error.message));
            else resolve(value || {});
          });
        });
      },
      set(entries) {
        return new Promise((resolve, reject) => {
          local.set(entries, () => {
            const error = globalThis.chrome?.runtime?.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          });
        });
      }
    };
  }

  function openManager() {
    if (state.open) return;
    previouslyFocusedElement = document.activeElement;
    state.open = true;
    state.view = "active";
    state.timeFilter = core.TIME_FILTER.ALL;
    state.query = "";
    setRecords([]);
    state.loadedViewKey = "";
    state.selected.clear();
    state.confirmDelete = false;
    state.result = "";
    state.error = "";
    ui = mountManager();
    updateAll({ rebuildList: true });
    ui.search.focus();
    void loadRecords();
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = createElement("div", "cgn-conversation-manager-root");
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }
    return root;
  }

  function mountManager() {
    const root = ensureRoot();
    const overlay = createElement("div", "cgn-manager-overlay");
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay && !state.running) closeManager();
    });
    const panel = createElement("section", "cgn-manager-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "cgn-manager-title");

    const header = createElement("header", "cgn-manager-header");
    const headingWrap = createElement("div", "cgn-manager-heading");
    const heading = createElement("h2", "", "会话管理");
    heading.id = "cgn-manager-title";
    headingWrap.append(heading, createElement("p", "", "ChatGPT 网页聊天（含工作模式）"));
    const headerActions = createElement("div", "cgn-manager-header-actions");
    const refresh = createButton("同步", "cgn-manager-ghost-btn", () => void loadRecords({ forceIncremental: true }));
    refresh.title = "使用本地索引快速检查最新变化";
    const fullRefresh = createButton("全量", "cgn-manager-ghost-btn", () => void loadRecords({ forceFull: true }));
    fullRefresh.title = "重新读取全部聊天，校准其他设备产生的旧记录变化";
    const close = createButton("×", "cgn-manager-close", closeManager);
    headerActions.append(refresh, fullRefresh, close);
    header.append(headingWrap, headerActions);

    const accountRow = createElement("div", "cgn-manager-account-row cgn-manager-hidden");
    accountRow.appendChild(createElement("span", "", "账号"));
    const accountSelect = createElement("select", "cgn-manager-select");
    accountSelect.addEventListener("change", () => {
      state.accountId = accountSelect.value;
      resetForViewChange();
      void loadRecords();
    });
    accountRow.appendChild(accountSelect);

    const filters = createElement("div", "cgn-manager-filters");
    const statusGroup = createElement("div", "cgn-manager-segments");
    const statusButtons = new Map();
    for (const [value, config] of Object.entries(VIEW_CONFIG)) {
      const button = createButton(config.label, "cgn-manager-segment", () => {
        if (state.view === value) return;
        state.view = value;
        resetForViewChange();
        void loadRecords();
      });
      statusButtons.set(value, button);
      statusGroup.appendChild(button);
    }
    filters.appendChild(statusGroup);

    const timeGroup = createElement("div", "cgn-manager-time-filters");
    const timeButtons = new Map();
    for (const [value, label] of TIME_FILTERS) {
      const button = createButton(label, "cgn-manager-time-btn", () => {
        if (state.timeFilter === value) return;
        state.timeFilter = value;
        clearSelection();
        updateAll({ rebuildList: true });
      });
      timeButtons.set(value, button);
      timeGroup.appendChild(button);
    }
    filters.appendChild(timeGroup);

    const search = createElement("input", "cgn-manager-search");
    search.type = "search";
    search.placeholder = "按聊天标题搜索…";
    search.addEventListener("input", () => {
      if (searchTimer !== null) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        state.query = search.value;
        clearSelection();
        updateAll({ rebuildList: true });
      }, 150);
    });
    filters.appendChild(search);

    const syncStatus = createElement("div", "cgn-manager-loading cgn-manager-hidden");
    syncStatus.setAttribute("role", "status");
    syncStatus.setAttribute("aria-live", "polite");
    const alerts = createElement("div", "cgn-manager-alerts");

    const toolbar = createElement("div", "cgn-manager-list-toolbar");
    const listCount = createElement("span");
    const selectionActions = createElement("div", "cgn-manager-selection-actions cgn-manager-segments");
    const selectAll = createButton("全选当前结果", "cgn-manager-segment", () => {
      state.selected = new Set(core.getBulkSelectableIds(state.filteredRecords, currentConversationId()));
      state.confirmDelete = false;
      updateSelectionAndActions();
    });
    const clear = createButton("清空选择", "cgn-manager-segment", clearSelection);
    selectionActions.append(selectAll, clear);
    toolbar.append(listCount, selectionActions);

    const list = createElement("div", "cgn-manager-list");
    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 160) appendNextRows();
    });

    const confirm = createElement("div", "cgn-manager-delete-confirm cgn-manager-hidden");
    const footer = createElement("footer", "cgn-manager-footer");
    const footerStatus = createElement("span", "cgn-manager-footer-status");
    const footerActions = createElement("div", "cgn-manager-footer-actions");
    const primary = createButton("归档", "cgn-manager-primary-btn", () => {
      const action = VIEW_CONFIG[state.view]?.primaryAction;
      if (action) void executeBatch(action);
    });
    const remove = createButton("删除", "cgn-manager-danger-outline-btn", () => {
      state.confirmDelete = true;
      updateConfirm();
    });
    const stop = createButton("停止后续操作", "cgn-manager-stop-btn cgn-manager-hidden", () => state.batchController?.abort());
    footerActions.append(primary, remove, stop);
    footer.append(footerStatus, footerActions);

    panel.append(header, accountRow, filters, syncStatus, alerts, toolbar, list, confirm, footer);
    overlay.appendChild(panel);
    root.appendChild(overlay);
    return {
      root, overlay, panel, refresh, fullRefresh, close, accountRow, accountSelect, statusButtons, timeButtons,
      search, syncStatus, alerts, listCount, selectAll, clear, list, confirm, footerStatus, primary, remove, stop
    };
  }

  function closeManager() {
    if (state.running) return;
    state.open = false;
    state.loadController?.abort();
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = null;
    ui?.root.remove();
    ui = null;
    if (previouslyFocusedElement && previouslyFocusedElement.isConnected && typeof previouslyFocusedElement.focus === "function") {
      previouslyFocusedElement.focus();
    }
    previouslyFocusedElement = null;
  }

  function resetForViewChange() {
    state.loadController?.abort();
    setRecords([]);
    state.loadedViewKey = "";
    state.cacheSyncedAt = 0;
    state.result = "";
    state.error = "";
    clearSelection();
    updateAll({ rebuildList: true });
  }

  async function loadRecords({ forceFull = false, forceIncremental = false } = {}) {
    state.loadController?.abort();
    const requestedView = state.view;
    const controller = new AbortController();
    state.loadController = controller;
    state.loading = true;
    state.error = "";
    state.result = "";
    state.warnings = [];
    state.cacheWarning = "";
    state.canMutate = false;
    state.protectionVerified = false;
    state.syncMessage = "正在识别 ChatGPT 账号…";
    updateAll();
    const progressUpdater = createThrottledUpdater((progress) => {
      if (!state.open || state.loadController !== controller) return;
      state.syncMessage = progress?.label || "正在同步聊天索引…";
      updateSyncStatus();
    });
    try {
      const sync = await syncEngine.load({
        accountId: state.accountId,
        view: requestedView,
        forceFull,
        forceIncremental,
        signal: controller.signal,
        onAuthenticated(auth) {
          state.accounts = auth.accounts;
          state.accountId = auth.accountId;
        },
        onCached(cached) {
          if (controller.signal.aborted) return;
          const viewKey = `${state.accountId}:${requestedView}`;
          state.cacheSyncedAt = cached.syncedAt;
          state.syncMessage = `本地缓存 · 上次同步 ${formatSyncTime(cached.syncedAt)}`;
          if (state.loadedViewKey !== viewKey || state.records.length === 0) {
            setRecords(cached.records);
            state.loadedViewKey = viewKey;
            updateAll({ rebuildList: true });
          } else updateAll();
        },
        onProgress(progress) { progressUpdater.push(progress); }
      });
      if (controller.signal.aborted) return;
      if (sync.stale) return;
      progressUpdater.flush();
      const { result, records: syncedRecords, cached, mode, syncedAt } = sync;
      const recordsChanged = !conversationRecordsEqual(state.records, syncedRecords);
      setRecords(syncedRecords);
      state.loadedViewKey = `${result.accountId}:${requestedView}`;
      state.warnings = result.warnings;
      state.protectionVerified = result.protectionVerified;
      state.canMutate = result.canMutate;
      state.cacheSyncedAt = result.compatible ? syncedAt : (cached?.syncedAt || 0);
      if (sync.cacheError) {
        state.cacheWarning = `本地缓存不可用：${friendlyError(sync.cacheError)}`;
      } else if (sync.writeError) {
        state.cacheWarning = `会话已保留在内存中，但本地索引写入失败：${friendlyError(sync.writeError)}`;
      } else if (!result.compatible && cached) {
        state.cacheWarning = "接口兼容性检查未通过，本次结果没有覆盖本地索引。";
      }
      const viewLabel = requestedView === "scheduled" ? "已安排会话" : "聊天";
      state.syncMessage = result.compatible
        ? `同步完成 · ${syncedRecords.length} 条${viewLabel} · ${formatSyncTime(syncedAt)}`
        : "需要全量刷新 · 当前接口兼容性检查未通过";
      updateAll({ rebuildList: recordsChanged, preserveScroll: true });
    } catch (error) {
      if (!isAbortError(error)) {
        state.error = friendlyError(error);
        state.syncMessage = state.records.length
          ? "需要全量刷新 · 当前继续显示本地缓存"
          : "读取失败 · 请刷新页面后重试";
        updateAll();
      }
    } finally {
      progressUpdater.cancel();
      if (state.loadController === controller) {
        state.loading = false;
        state.loadController = null;
        updateAll();
      }
    }
  }

  function visibleRecords() {
    return core.filterConversationView(state.records, {
      view: state.view,
      timeFilter: state.timeFilter,
      query: state.query
    });
  }

  async function executeBatch(action) {
    const ids = [...state.selected];
    if (!ids.length || state.running || state.loading || !state.canMutate) return;
    const affectedRecords = state.records.filter((record) => state.selected.has(record.id));
    const affectedById = new Map(affectedRecords.map((record) => [record.id, record]));
    const controller = new AbortController();
    state.confirmDelete = false;
    state.batchController = controller;
    state.running = true;
    state.progress = { completed: 0, total: ids.length };
    state.error = "";
    state.result = "";
    updateAll();
    const progressUpdater = createThrottledUpdater((progress) => {
      if (!state.open || state.batchController !== controller) return;
      state.progress = progress;
      updateFooter();
    });
    const successUpdater = createThrottledUpdater(() => {
      if (!state.open || state.batchController !== controller) return;
      updateAll({ rebuildList: true, preserveScroll: true });
    });
    try {
      const result = await repository.runBatch({
        action,
        ids,
        signal: controller.signal,
        onProgress(progress) { progressUpdater.push(progress); },
        onItemResult(item) {
          // Only a confirmed success is allowed to disappear.  Failed and
          // aborted work remains selected for an explicit retry.
          if (item.status !== "succeeded") return;
          const record = affectedById.get(item.id);
          if (!record) return;
          const nextView = applyConfirmedBatchItem(state.records, state.selected, item);
          setRecords(nextView.records);
          state.selected = nextView.selected;
          syncEngine.queueMutation({
            accountId: state.accountId,
            action,
            id: item.id,
            record,
            onError(error) {
              state.cacheWarning = `操作已完成，但本地索引更新失败：${friendlyError(error)}。请执行全量刷新。`;
            }
          });
          successUpdater.push(item.id);
        }
      });
      progressUpdater.flush();
      state.selected = new Set([...result.failed.map((item) => item.id), ...result.unprocessed]);
      await syncEngine.flushMutations(state.accountId);
      const details = [
        `成功 ${result.succeeded.length} 条`,
        `失败 ${result.failed.length} 条`,
        `未处理 ${result.unprocessed.length} 条`
      ];
      state.result = `${actionLabel(action)}完成：${details.join("，")}。ChatGPT 左侧栏可能需要刷新页面后同步。`;
      if (result.fatalError) {
        state.error = result.fatalError;
      } else if (result.failed.length) {
        const recordTitles = new Map(affectedRecords.map((record) => [record.id, record.title]));
        const failureGroups = new Map();
        for (const item of result.failed) {
          const message = item.message || "未知错误";
          const titles = failureGroups.get(message) || [];
          titles.push(recordTitles.get(item.id) || item.id);
          failureGroups.set(message, titles);
        }
        const detailsByReason = [...failureGroups].map(([message, titles]) => {
          const titleSummary = titles.length > 3
            ? `${titles.slice(0, 3).join("、")}等 ${titles.length} 条`
            : titles.join("、");
          return `${titleSummary}：${message}`;
        });
        state.error = `失败详情：${detailsByReason.join("；")}。失败项已保持选中，可直接重试。`;
      }
    } catch (error) {
      if (!isAbortError(error)) state.error = friendlyError(error);
    } finally {
      progressUpdater.cancel();
      successUpdater.cancel();
      state.running = false;
      state.progress = null;
      state.batchController = null;
      updateAll({ rebuildList: true, preserveScroll: true });
    }
  }

  function updateAll({ rebuildList = false, preserveScroll = false } = {}) {
    if (!ui || !state.open) return;
    updateAccounts();
    updateFilters();
    updateSyncStatus();
    updateAlerts();
    if (rebuildList) renderList({ preserveScroll });
    updateEmptyState();
    updateSelectionAndActions();
  }

  function updateAccounts() {
    if (!ui) return;
    const signature = state.accounts.map((account) => `${account.id}:${account.label}`).join("|");
    if (ui.accountSelect.dataset.signature !== signature) {
      ui.accountSelect.replaceChildren();
      for (const account of state.accounts) {
        const option = createElement("option", "", account.label);
        option.value = account.id;
        ui.accountSelect.appendChild(option);
      }
      ui.accountSelect.dataset.signature = signature;
    }
    ui.accountSelect.value = state.accountId || "";
    ui.accountRow.classList.toggle("cgn-manager-hidden", state.accounts.length <= 1);
  }

  function updateFilters() {
    if (!ui) return;
    for (const [value, button] of ui.statusButtons) button.dataset.active = String(state.view === value);
    for (const [value, button] of ui.timeButtons) button.dataset.active = String(state.timeFilter === value);
    if (document.activeElement !== ui.search && ui.search.value !== state.query) ui.search.value = state.query;
  }

  function updateSyncStatus() {
    if (!ui) return;
    ui.syncStatus.textContent = state.syncMessage;
    ui.syncStatus.classList.toggle("cgn-manager-hidden", !state.syncMessage);
  }

  function updateAlerts() {
    if (!ui) return;
    const fragment = document.createDocumentFragment();
    if (state.error) fragment.appendChild(createElement("div", "cgn-manager-alert cgn-manager-alert-error", state.error));
    if (state.cacheWarning) fragment.appendChild(createElement("div", "cgn-manager-alert cgn-manager-alert-warning", state.cacheWarning));
    for (const warning of state.warnings) {
      fragment.appendChild(createElement("div", "cgn-manager-alert cgn-manager-alert-warning", warning));
    }
    if (!state.protectionVerified && !state.loading && state.view === "active") {
      fragment.appendChild(createElement("div", "cgn-manager-alert cgn-manager-alert-warning", "未能验证全部置顶信息，已禁用全选；仍可在验证通过后逐条选择。"));
    }
    if (state.result) fragment.appendChild(createElement("div", "cgn-manager-alert cgn-manager-alert-success", state.result));
    ui.alerts.replaceChildren(fragment);
  }

  function renderList({ preserveScroll = false } = {}) {
    if (!ui) return;
    const scrollTop = preserveScroll ? ui.list.scrollTop : 0;
    state.filteredRecords = visibleRecords();
    state.renderedCount = 0;
    ui.list.replaceChildren();
    appendNextRows();
    ui.list.scrollTop = scrollTop;
  }

  function appendNextRows() {
    if (!ui || state.renderedCount >= state.filteredRecords.length) {
      if (ui && !state.filteredRecords.length && !ui.list.childNodes.length) {
        const label = getEmptyStateLabel({ loading: state.loading, query: state.query, view: state.view });
        ui.list.appendChild(createElement("div", "cgn-manager-empty", label));
      }
      return;
    }
    const end = Math.min(state.renderedCount + LIST_BATCH_SIZE, state.filteredRecords.length);
    const fragment = document.createDocumentFragment();
    for (let index = state.renderedCount; index < end; index += 1) fragment.appendChild(createConversationRow(state.filteredRecords[index]));
    ui.list.appendChild(fragment);
    state.renderedCount = end;
  }

  function updateEmptyState() {
    if (!ui || state.filteredRecords.length) return;
    const label = getEmptyStateLabel({ loading: state.loading, query: state.query, view: state.view });
    const empty = ui.list.querySelector(".cgn-manager-empty");
    if (empty) empty.textContent = label;
    else if (!ui.list.childNodes.length) ui.list.appendChild(createElement("div", "cgn-manager-empty", label));
  }

  function createConversationRow(record) {
    const row = createElement("label", "cgn-manager-row");
    row.dataset.conversationId = record.id;
    row.dataset.selected = String(state.selected.has(record.id));
    row.dataset.disabled = String(record.automation);
    const checkbox = createElement("input", "cgn-manager-checkbox");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(record.id);
    checkbox.disabled = state.loading || state.running || VIEW_CONFIG[state.view].readOnly || record.automation || !state.canMutate;
    checkbox.setAttribute("aria-label", `选择 ${record.title}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(record.id);
      else state.selected.delete(record.id);
      row.dataset.selected = String(checkbox.checked);
      state.confirmDelete = false;
      updateSelectionAndActions();
    });
    const marker = createElement("span", "cgn-manager-checkmark");
    const info = createElement("span", "cgn-manager-row-info");
    info.appendChild(createElement("strong", "cgn-manager-row-title", record.title));
    info.appendChild(createElement("span", "cgn-manager-row-meta", `最后更新：${formatDate(record.updatedAt)}`));
    const badges = createElement("span", "cgn-manager-badges");
    if (record.projectId) badges.appendChild(createElement("em", "", "项目会话"));
    if (record.pinned) badges.appendChild(createElement("em", "", "置顶"));
    if (record.id === currentConversationId()) badges.appendChild(createElement("em", "", "当前"));
    if (record.automation) badges.appendChild(createElement("em", "", "自动化，请在“已安排”中管理"));
    info.appendChild(badges);
    row.append(checkbox, marker, info);
    return row;
  }

  function clearSelection() {
    state.selected.clear();
    state.confirmDelete = false;
    updateSelectionAndActions();
  }

  function updateSelectionAndActions() {
    updateSelectionUI();
    updateConfirm();
    updateFooter();
    updateControls();
  }

  function updateSelectionUI() {
    if (!ui) return;
    const selectableIds = core.getBulkSelectableIds(state.filteredRecords, currentConversationId());
    const allSelected = selectableIds.length > 0 && selectableIds.every((id) => state.selected.has(id));
    ui.listCount.textContent = `匹配 ${state.filteredRecords.length} 条 · 已选 ${state.selected.size} 条`;
    ui.selectAll.dataset.active = String(allSelected);
    ui.selectAll.disabled = VIEW_CONFIG[state.view].readOnly || state.loading || state.running || !selectableIds.length || !state.protectionVerified || !state.canMutate;
    ui.clear.disabled = !state.selected.size || state.running;
    for (const checkbox of ui.list.querySelectorAll(".cgn-manager-checkbox")) {
      const row = checkbox.closest(".cgn-manager-row");
      const id = row?.dataset.conversationId;
      checkbox.checked = state.selected.has(id);
      row.dataset.selected = String(checkbox.checked);
    }
  }

  function updateConfirm() {
    if (!ui) return;
    const visible = state.confirmDelete && state.selected.size > 0 && !state.running;
    ui.confirm.classList.toggle("cgn-manager-hidden", !visible);
    if (!visible) {
      ui.confirm.replaceChildren();
      return;
    }
    const selectedTitles = state.records
      .filter((record) => state.selected.has(record.id))
      .slice(0, 5)
      .map((record) => record.title);
    const confirmActions = createElement("div", "cgn-manager-confirm-actions");
    confirmActions.append(
      createButton("取消", "cgn-manager-ghost-btn", () => {
        state.confirmDelete = false;
        updateConfirm();
      }),
      createButton("确认永久删除", "cgn-manager-danger-btn", () => void executeBatch("delete"))
    );
    ui.confirm.replaceChildren(
      createElement("strong", "", `永久删除 ${state.selected.size} 条聊天？`),
      createElement("p", "", `${selectedTitles.join("、")}${state.selected.size > 5 ? "等" : ""}。删除后无法恢复。`),
      confirmActions
    );
  }

  function updateFooter() {
    if (!ui) return;
    ui.footerStatus.textContent = state.running && state.progress
      ? `已完成 ${state.progress.completed}/${state.progress.total}`
      : state.view === "scheduled" ? "已安排会话请前往 ChatGPT“已安排”管理" : `已选 ${state.selected.size} 条`;
    const viewConfig = VIEW_CONFIG[state.view];
    ui.primary.textContent = viewConfig.primaryLabel;
    ui.primary.classList.toggle("cgn-manager-hidden", state.running || viewConfig.readOnly);
    ui.remove.classList.toggle("cgn-manager-hidden", state.running || viewConfig.readOnly);
    ui.stop.classList.toggle("cgn-manager-hidden", !state.running);
  }

  function updateControls() {
    if (!ui) return;
    ui.refresh.disabled = state.loading || state.running;
    ui.fullRefresh.disabled = state.loading || state.running;
    ui.close.disabled = state.running;
    ui.close.title = state.running ? "请先停止批量操作" : "关闭";
    ui.accountSelect.disabled = state.running;
    ui.search.disabled = state.running;
    for (const button of ui.statusButtons.values()) button.disabled = state.running;
    for (const button of ui.timeButtons.values()) button.disabled = state.running;
    const writeDisabled = !state.selected.size || state.loading || state.running || !state.canMutate;
    ui.primary.disabled = writeDisabled;
    ui.remove.disabled = writeDisabled;
    for (const checkbox of ui.list.querySelectorAll(".cgn-manager-checkbox")) {
      const record = state.recordById.get(checkbox.closest(".cgn-manager-row")?.dataset.conversationId);
      checkbox.disabled = VIEW_CONFIG[state.view].readOnly || state.loading || state.running || !state.canMutate || Boolean(record?.automation);
    }
  }

  function formatSyncTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "未知";
    return SYNC_TIME_FORMATTER.format(new Date(timestamp));
  }

  document.addEventListener(OPEN_EVENT, openManager);
  document.addEventListener("keydown", (event) => {
    if (!state.open) return;
    if (event.key === "Escape" && !state.running) {
      closeManager();
      return;
    }
    if (event.key !== "Tab") return;
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const focusable = [...root.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });

  globalThis.CGNConversationManager = Object.freeze({
    open: openManager,
    createRepository: createChatHistoryRepository
  });
})();
