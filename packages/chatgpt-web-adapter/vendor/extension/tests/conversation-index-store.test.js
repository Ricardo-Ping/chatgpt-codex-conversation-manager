const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

const { createConversationIndexStore, STORAGE_PREFIX, SCHEDULED_SOURCE_VERSION } = require("../conversation-index-store.js");

function createMemoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) {
      return { [key]: structuredClone(values[key]) };
    },
    async set(entries) {
      Object.assign(values, structuredClone(entries));
    }
  };
}

test("stores minimal indexes in hashed account namespaces and isolates views", async () => {
  const storage = createMemoryStorage();
  const store = createConversationIndexStore({ storage, cryptoImpl: webcrypto, now: () => 1000 });
  await store.write("raw-account-a", "active", {
    records: [{ id: "one", title: "聊天一", updatedAt: 10, body: "must-not-be-stored" }],
    syncedAt: 900,
    fullSyncedAt: 800,
    checkpoints: { main: 10, projects: {} }
  });
  await store.write("raw-account-a", "archived", {
    records: [{ id: "old", title: "旧聊天", archived: true }],
    syncedAt: 950
  });
  await store.write("raw-account-a", "scheduled", {
    records: [{ id: "task:one", title: "每日提醒", automation: true }],
    syncedAt: 975
  });

  const keys = Object.keys(storage.values);
  assert.equal(keys.length, 1);
  assert.match(keys[0], new RegExp(`^${STORAGE_PREFIX}:`));
  assert.equal(keys[0].includes("raw-account-a"), false);
  assert.deepEqual((await store.read("raw-account-a", "active")).records.map((item) => item.id), ["one"]);
  assert.deepEqual((await store.read("raw-account-a", "archived")).records.map((item) => item.id), ["old"]);
  assert.deepEqual((await store.read("raw-account-a", "scheduled")).records.map((item) => item.id), ["task:one"]);
  assert.equal(JSON.stringify(storage.values).includes("must-not-be-stored"), false);
  assert.equal(await store.read("raw-account-b", "active"), null);
});

test("discards incompatible or corrupt cache entries", async () => {
  const storage = createMemoryStorage();
  const store = createConversationIndexStore({ storage, cryptoImpl: webcrypto });
  const key = await store.accountKey("account-a");
  storage.values[key] = { schemaVersion: 999, views: { active: { records: [{ id: "bad" }] } } };
  assert.equal(await store.read("account-a", "active"), null);
  storage.values[key] = { schemaVersion: 1, views: { active: { records: "bad" } } };
  assert.equal(await store.read("account-a", "active"), null);
  storage.values[key] = {
    schemaVersion: 1,
    lastAccessedAt: 1,
    views: {
      active: {
        records: [{ id: "bad", title: 123 }],
        syncedAt: 1,
        fullSyncedAt: 1,
        checkpoints: { main: null, projects: {} }
      }
    }
  };
  assert.equal(await store.read("account-a", "active"), null);
  storage.values[key].views.active.records = [];
  storage.values[key].views.active.checkpoints.projects = { project: "not-a-timestamp" };
  assert.equal(await store.read("account-a", "active"), null);
});

test("invalidates only the legacy scheduled cache when its task source changes", async () => {
  const storage = createMemoryStorage();
  const store = createConversationIndexStore({ storage, cryptoImpl: webcrypto, now: () => 1000 });
  await store.write("account-a", "active", { records: [{ id: "chat", title: "普通聊天" }] });
  await store.write("account-a", "scheduled", { records: [{ id: "stale", title: "错误任务", automation: true }] });
  const key = await store.accountKey("account-a");
  delete storage.values[key].scheduledSourceVersion;

  assert.equal(await store.read("account-a", "scheduled"), null);
  assert.deepEqual((await store.read("account-a", "active")).records.map((item) => item.id), ["chat"]);

  await store.write("account-a", "scheduled", { records: [{ id: "valid", title: "活动提醒", automation: true }] });
  assert.equal(storage.values[key].scheduledSourceVersion, SCHEDULED_SOURCE_VERSION);
  assert.deepEqual((await store.read("account-a", "scheduled")).records.map((item) => item.id), ["valid"]);
});

test("moves or removes only successful batch records", async () => {
  const storage = createMemoryStorage();
  const store = createConversationIndexStore({ storage, cryptoImpl: webcrypto, now: () => 2000 });
  const active = [
    { id: "ok", title: "成功", archived: false },
    { id: "failed", title: "失败", archived: false }
  ];
  await store.write("account-a", "active", { records: active });
  await store.write("account-a", "archived", { records: [] });
  await store.applyBatch("account-a", { action: "archive", succeeded: ["ok"], records: active });
  assert.deepEqual((await store.read("account-a", "active")).records.map((item) => item.id), ["failed"]);
  assert.deepEqual((await store.read("account-a", "archived")).records.map((item) => item.id), ["ok"]);
  await store.applyBatch("account-a", { action: "delete", succeeded: ["ok"], records: active });
  assert.deepEqual((await store.read("account-a", "archived")).records, []);
});

test("surfaces storage quota failures without mutating the caller's records", async () => {
  const storage = createMemoryStorage();
  storage.set = async () => { throw new Error("QUOTA_BYTES quota exceeded"); };
  const store = createConversationIndexStore({ storage, cryptoImpl: webcrypto });
  const records = [{ id: "one", title: "聊天一" }];
  await assert.rejects(store.write("account-a", "active", { records }), /quota/i);
  assert.deepEqual(records, [{ id: "one", title: "聊天一" }]);
});

test("coalesces confirmed mutations into one account-index write", async () => {
  const storage = createMemoryStorage();
  let writes = 0;
  const originalSet = storage.set;
  storage.set = async (entries) => {
    writes += 1;
    return originalSet(entries);
  };
  const store = createConversationIndexStore({ storage, cryptoImpl: webcrypto, now: () => 3000 });
  await store.write("account-a", "active", {
    records: [{ id: "one", title: "一" }, { id: "two", title: "二" }]
  });
  writes = 0;
  const writer = store.createMutationWriter("account-a", {
    schedule() { return null; },
    cancel() {}
  });
  writer.push({ action: "archive", succeeded: ["one"], records: [{ id: "one", title: "一" }] });
  writer.push({ action: "delete", succeeded: ["two"], records: [{ id: "two", title: "二" }] });
  await writer.flush();
  assert.equal(writes, 1);
  assert.deepEqual((await store.read("account-a", "active")).records, []);
  assert.deepEqual((await store.read("account-a", "archived")).records.map((record) => record.id), ["one"]);
});
