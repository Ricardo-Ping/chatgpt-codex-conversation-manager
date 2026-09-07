const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../conversation-manager-core.js");

test("normalizes timestamps and conversation metadata", () => {
  const record = core.normalizeConversation({
    id: "abc",
    title: "  示例聊天  ",
    create_time: "2026-01-01T00:00:00Z",
    update_time: 1767225600,
    pinned_time: "2026-02-01T00:00:00Z",
    gizmo_id: "g-p-one"
  });
  assert.equal(record.id, "abc");
  assert.equal(record.title, "示例聊天");
  assert.equal(record.updatedAt, 1767225600000);
  assert.equal(record.pinned, true);
  assert.equal(record.projectId, "g-p-one");
});

test("uses exact rolling cutoffs for one day and one week", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  assert.equal(core.computeCutoff(core.TIME_FILTER.DAY, now), now - 24 * 60 * 60 * 1000);
  assert.equal(core.computeCutoff(core.TIME_FILTER.WEEK, now), now - 7 * 24 * 60 * 60 * 1000);
});

test("clamps calendar month cutoff at month end", () => {
  const now = new Date(2026, 2, 31, 12, 30, 0, 0);
  const expected = new Date(2026, 1, 28, 12, 30, 0, 0);
  assert.equal(core.computeCutoff(core.TIME_FILTER.MONTH, now), expected.getTime());
});

test("clamps half-year cutoff using local calendar months", () => {
  const now = new Date(2026, 7, 31, 9, 15, 0, 0);
  const expected = new Date(2026, 1, 28, 9, 15, 0, 0);
  assert.equal(core.computeCutoff(core.TIME_FILTER.HALF_YEAR, now), expected.getTime());
});

test("one-day cutoff remains exactly 24 hours across a DST transition", () => {
  const now = Date.parse("2026-03-09T04:30:00-04:00");
  const cutoff = core.computeCutoff(core.TIME_FILTER.DAY, now);
  assert.equal(now - cutoff, 24 * 60 * 60 * 1000);
});

test("filters strictly older conversations by update time and title", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  const records = [
    { id: "old-match", title: "数据库研究", updatedAt: now - 8 * 24 * 60 * 60 * 1000, archived: false },
    { id: "edge", title: "数据库边界", updatedAt: now - 7 * 24 * 60 * 60 * 1000, archived: false },
    { id: "other", title: "其他主题", updatedAt: now - 9 * 24 * 60 * 60 * 1000, archived: false },
    { id: "unknown", title: "数据库未知", updatedAt: null, archived: false }
  ];
  const filtered = core.filterConversations(records, {
    archiveState: "active",
    timeFilter: core.TIME_FILTER.WEEK,
    query: "数据库",
    now
  });
  assert.deepEqual(filtered.map((item) => item.id), ["old-match"]);
});

test("invalid update times are retained only when no time cutoff is active", () => {
  const record = core.normalizeConversation({ id: "invalid", title: "无效时间", update_time: "not-a-date" });
  assert.equal(record.updatedAt, null);
  assert.equal(core.filterConversations([record], { timeFilter: core.TIME_FILTER.ALL }).length, 1);
  assert.equal(core.filterConversations([record], { timeFilter: core.TIME_FILTER.DAY }).length, 0);
});

test("merges duplicate records and keeps protective metadata", () => {
  const merged = core.mergeConversations([
    [{ id: "same", title: "聊天", updatedAt: 10, pinned: false, automation: false }],
    [{ id: "same", title: "未命名聊天", updatedAt: 20, pinned: true, automation: true, projectId: "g-p" }]
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "聊天");
  assert.equal(merged[0].updatedAt, 20);
  assert.equal(merged[0].pinned, true);
  assert.equal(merged[0].automation, true);
  assert.equal(merged[0].projectId, "g-p");
});

test("an incrementally fetched newer title replaces the cached title", () => {
  const merged = core.mergeConversations([
    [{ id: "same", title: "旧标题", updatedAt: 10, archived: false }],
    [{ id: "same", title: "新标题", updatedAt: 20, archived: false }]
  ]);
  assert.equal(merged[0].title, "新标题");
});

test("bulk selection skips pinned, current, automation, and temporary chats", () => {
  const records = [
    { id: "normal" },
    { id: "pinned", pinned: true },
    { id: "current" },
    { id: "automation", automation: true },
    { id: "temporary", temporary: true }
  ];
  assert.deepEqual(core.getBulkSelectableIds(records, "current"), ["normal"]);
});

test("separates scheduled conversations from the ordinary active view", () => {
  const records = [
    { id: "normal", title: "普通聊天", archived: false, automation: false },
    { id: "scheduled", title: "云端定时任务", archived: false, automation: true },
    { id: "archived", title: "已归档", archived: true, automation: false }
  ];
  assert.deepEqual(core.filterConversationView(records, { view: "active" }).map((item) => item.id), ["normal"]);
  assert.deepEqual(core.filterConversationView(records, { view: "scheduled" }).map((item) => item.id), ["scheduled"]);
  assert.deepEqual(core.filterConversationView(records, { view: "archived" }).map((item) => item.id), ["archived"]);
});

test("chooses cache validation, incremental sync, and full calibration deterministically", () => {
  const now = 1_000_000;
  assert.equal(core.chooseSyncMode({ hasCache: false, now }), "full");
  assert.equal(core.chooseSyncMode({ hasCache: true, syncedAt: now - 119_999, now }), "validate");
  assert.equal(core.chooseSyncMode({ hasCache: true, syncedAt: now - 120_001, now }), "incremental");
  assert.equal(core.chooseSyncMode({ hasCache: true, syncedAt: now, now, forceIncremental: true }), "incremental");
  assert.equal(core.chooseSyncMode({ hasCache: true, syncedAt: now, now, forceFull: true }), "full");
});

test("rejects incompatible conversation page responses", () => {
  assert.throws(() => core.validateConversationPage({ data: [] }), /接口结构已变化/);
  assert.deepEqual(core.validateConversationPage({ conversations: [{ id: "x" }] }), [{ id: "x" }]);
});
