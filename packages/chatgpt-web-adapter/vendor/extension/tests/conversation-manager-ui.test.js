const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { applyConfirmedBatchItem, conversationRecordsEqual, createConversationSyncEngine, createThrottledUpdater, getEmptyStateLabel } = require("../conversation-manager.js");

test("progress updates are coalesced to at most one visible update per interval", () => {
  let clock = 0;
  let scheduled = null;
  const values = [];
  const updater = createThrottledUpdater((value) => values.push(value), {
    interval: 100,
    now: () => clock,
    schedule(task, delay) {
      scheduled = { task, delay };
      return scheduled;
    },
    cancelSchedule() { scheduled = null; }
  });
  updater.push("first");
  clock = 10;
  updater.push("second");
  clock = 50;
  updater.push("latest");
  assert.deepEqual(values, ["first"]);
  assert.equal(scheduled.delay, 90);
  clock = 100;
  scheduled.task();
  assert.deepEqual(values, ["first", "latest"]);
});

test("manager keeps stable roots and hides inactive destructive controls", () => {
  const manager = fs.readFileSync(path.join(__dirname, "..", "conversation-manager.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "content.css"), "utf8");
  assert.doesNotMatch(manager, /root\.innerHTML\s*=/);
  assert.match(manager, /ui\.list\.replaceChildren\(\)/);
  assert.match(css, /\.cgn-manager-hidden\s*\{\s*display:\s*none\s*!important;/s);
  assert.match(manager, /scheduled:\s*Object\.freeze\(\{\s*label:\s*"已安排"/);
  assert.match(manager, /"项目会话"/);
});

test("toolbar exposes fast incremental sync separately from full calibration", () => {
  const manager = fs.readFileSync(path.join(__dirname, "..", "conversation-manager.js"), "utf8");
  assert.match(manager, /createButton\("同步"[\s\S]*forceIncremental:\s*true/);
  assert.match(manager, /createButton\("全量"[\s\S]*forceFull:\s*true/);
  assert.match(manager, /createConversationSyncEngine/);
  assert.match(manager, /snapshots\.get\(viewKey\)/);
  assert.match(manager, /mode === "full" \|\| view === "scheduled"\s*\? result\.records/);
});

test("only confirmed batch successes leave the visible list", () => {
  const records = [{ id: "ok" }, { id: "failed" }];
  const selected = new Set(["ok", "failed"]);
  const failed = applyConfirmedBatchItem(records, selected, { id: "failed", status: "failed" });
  assert.deepEqual(failed.records.map((record) => record.id), ["ok", "failed"]);
  assert.deepEqual([...failed.selected], ["ok", "failed"]);

  const succeeded = applyConfirmedBatchItem(records, selected, { id: "ok", status: "succeeded" });
  assert.deepEqual(succeeded.records.map((record) => record.id), ["failed"]);
  assert.deepEqual([...succeeded.selected], ["failed"]);
});

test("sync engine patches its memory snapshot after a confirmed mutation", async () => {
  const records = [{ id: "one", title: "聊天", archived: false }];
  const repository = {
    async bootstrap() { return { accountId: "account-a", accounts: [{ id: "account-a" }] }; },
    async loadAll() {
      return {
        accountId: "account-a", accounts: [{ id: "account-a" }], records,
        compatible: true, checkpoints: { main: null, projects: {} }
      };
    }
  };
  const written = [];
  const indexStore = {
    async read() { return null; },
    async write() {},
    async applyBatches(_accountId, operations) { written.push(...operations); }
  };
  const engine = createConversationSyncEngine({ repository, indexStore, now: () => 1000 });
  await engine.load({ view: "active" });
  engine.queueMutation({ accountId: "account-a", action: "archive", id: "one", record: records[0] });
  const cached = [];
  await engine.load({ view: "active", onCached(view) { cached.push(view.records.map((record) => record.id)); } });
  assert.deepEqual(cached[0], []);
  assert.equal(written.length, 1);
});

test("a late sync generation cannot overwrite a newer view snapshot or index", async () => {
  const loads = [];
  const writes = [];
  const repository = {
    async bootstrap() { return { accountId: "account-a", accounts: [{ id: "account-a" }] }; },
    loadAll() { return new Promise((resolve) => loads.push(resolve)); }
  };
  const indexStore = {
    async read() { return null; },
    async write(_account, _view, value) { writes.push(value.records.map((record) => record.id)); }
  };
  const engine = createConversationSyncEngine({ repository, indexStore, now: () => 1000 });
  const first = engine.load({ view: "active" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = engine.load({ view: "active" });
  await new Promise((resolve) => setImmediate(resolve));
  const result = (id) => ({
    accountId: "account-a", accounts: [], records: [{ id, title: id, archived: false }],
    compatible: true, checkpoints: { main: null, projects: {} }
  });
  loads[1](result("new"));
  assert.deepEqual((await second).records.map((record) => record.id), ["new"]);
  loads[0](result("old"));
  assert.equal((await first).stale, true);
  assert.deepEqual(writes, [["new"]]);
});

test("an immediate load flushes a confirmed mutation and does not revive it from a stale response", async () => {
  const persisted = { records: [{ id: "gone", title: "旧聊天", archived: false }], syncedAt: 1, fullSyncedAt: 1, checkpoints: { main: null, projects: {} } };
  const events = [];
  const repository = {
    async bootstrap() { return { accountId: "account-a", accounts: [{ id: "account-a" }] }; },
    async loadAll() {
      events.push("network");
      return {
        accountId: "account-a", accounts: [], records: [{ id: "gone", title: "旧聊天", archived: false }],
        compatible: true, checkpoints: { main: null, projects: {} }
      };
    }
  };
  const indexStore = {
    async applyBatches(_account, operations) {
      events.push("mutation");
      for (const operation of operations) {
        persisted.records = persisted.records.filter((record) => !operation.succeeded.includes(record.id));
      }
    },
    async read() { return structuredClone(persisted); },
    async write(_account, _view, view) { persisted.records = structuredClone(view.records); }
  };
  const engine = createConversationSyncEngine({ repository, indexStore, now: () => 2000 });
  engine.queueMutation({ accountId: "account-a", action: "delete", id: "gone", record: persisted.records[0] });
  const sync = await engine.load({ view: "active" });
  assert.deepEqual(events, ["mutation", "network"]);
  assert.deepEqual(sync.records, []);
  assert.deepEqual(persisted.records, []);
});

test("mutation journal expires so later full calibration can reflect another device", async () => {
  let clock = 1000;
  const serverRecord = { id: "shared", title: "跨设备恢复", archived: false };
  const repository = {
    async bootstrap() { return { accountId: "account-a", accounts: [] }; },
    async loadAll() {
      return {
        accountId: "account-a", accounts: [], records: [serverRecord], compatible: true,
        checkpoints: { main: null, projects: {} }
      };
    }
  };
  const indexStore = {
    async applyBatches() {},
    async read() { return null; },
    async write() {}
  };
  const engine = createConversationSyncEngine({ repository, indexStore, now: () => clock });
  engine.queueMutation({ accountId: "account-a", action: "delete", id: "shared", record: serverRecord });
  assert.deepEqual((await engine.load({ view: "active", forceFull: true })).records, []);
  clock += 2 * 60 * 1000 + 1;
  assert.deepEqual((await engine.load({ view: "active", forceFull: true })).records.map((record) => record.id), ["shared"]);
});

test("a load waits for an already-started deferred mutation write", async () => {
  let scheduled;
  let releaseMutation;
  const events = [];
  const repository = {
    async bootstrap() { return { accountId: "account-a", accounts: [] }; },
    async loadAll() {
      events.push("network");
      return { accountId: "account-a", accounts: [], records: [], compatible: true, checkpoints: { main: null, projects: {} } };
    }
  };
  const indexStore = {
    applyBatches() {
      events.push("mutation");
      return new Promise((resolve) => { releaseMutation = resolve; });
    },
    async read() { return null; },
    async write() {}
  };
  const engine = createConversationSyncEngine({
    repository,
    indexStore,
    schedule(task) { scheduled = task; return 1; },
    cancelSchedule() {}
  });
  engine.queueMutation({ accountId: "account-a", action: "delete", id: "gone", record: { id: "gone", title: "旧聊天" } });
  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  const loading = engine.load({ view: "active" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["mutation"]);
  releaseMutation();
  await loading;
  assert.deepEqual(events, ["mutation", "network"]);
});

test("empty state leaves loading state and names the scheduled view accurately", () => {
  assert.equal(getEmptyStateLabel({ loading: true, view: "scheduled" }), "正在读取已安排会话…");
  assert.equal(getEmptyStateLabel({ loading: false, view: "scheduled" }), "当前条件下没有已安排会话。");
  assert.equal(getEmptyStateLabel({ loading: false, query: "研究", view: "scheduled" }), "没有匹配的已安排会话。");
  assert.equal(getEmptyStateLabel({ loading: false, view: "active" }), "当前条件下没有聊天。");
});

test("unchanged sync records do not require rebuilding list rows", () => {
  const records = [{ id: "one", title: "聊天", updatedAt: 1, archived: false, pinned: false, projectId: null, automation: false, temporary: false }];
  assert.equal(conversationRecordsEqual(records, structuredClone(records)), true);
  assert.equal(conversationRecordsEqual(records, [{ ...records[0], pinned: true }]), false);
  assert.equal(conversationRecordsEqual(records, [...records, { ...records[0], id: "two" }]), false);
});
