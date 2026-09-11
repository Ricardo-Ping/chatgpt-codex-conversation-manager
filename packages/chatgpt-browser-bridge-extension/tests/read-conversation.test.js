const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

test("readConversation resolves the account key, sends the raw account id and linearizes messages", async () => {
  const rawId = "raw-1";
  const accountKey = createHash("sha256").update(rawId).digest("hex");
  const mapping = {
    root: { message: null, parent: null, children: ["n1"] },
    n1: { parent: "root", children: ["n2"], message: { author: { role: "user" }, create_time: 1000, content: { parts: ["第一问"] } } },
    n2: { parent: "n1", children: [], message: { author: { role: "assistant" }, content: { parts: ["第一答"] } } },
    orphan: { parent: "ghost", children: [], message: { author: { role: "assistant" }, content: { parts: ["孤儿节点"] } } }
  };
  const seen = [];
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    tabs: { async query() { return []; }, async sendMessage() {}, create() {} }
  };
  globalThis.chrome = chrome;
  delete require.cache[require.resolve("../bridge-core.js")];
  const { ChatGptRepository } = require("../bridge-core.js");
  const repo = new ChatGptRepository();
  repo.auth = { token: "token-1", rows: [{ rawId }] };
  repo.fetch = async (path, options = {}) => {
    seen.push({ path, headers: options.headers ?? {} });
    return { ok: true, status: 200, json: async () => ({ title: "T", mapping }) };
  };
  const transcript = await repo.readConversation(accountKey, "conv-1");
  assert.equal(transcript.title, "T");
  assert.deepEqual(transcript.messages.map((m) => m.text), ["第一问", "第一答"]);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].path.includes("/backend-api/conversation/conv-1"));
  assert.equal(seen[0].headers["ChatGPT-Account-Id"], rawId);
});
