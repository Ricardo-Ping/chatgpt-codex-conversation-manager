"use strict";
// 与桌面端 extension-integrity.test.ts 的 referenceHash 互为镜像：两端必须对同一份字节
// 算出相同指纹，桌面端才能据此判定"运行中的 SW 落后于磁盘文件"。
const test = require("node:test"), assert = require("node:assert/strict"), nodeCrypto = require("node:crypto");

function loadBackground(chrome) { globalThis.chrome = chrome; delete require.cache[require.resolve("../background.js")]; return require("../background.js"); }

test("reports a memoized startup code hash on the poll for desktop drift detection", async () => {
  if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const calls = [];
  const storage = { seq: [{}, { bridgeSecret: "s" }, {}], i: 0 };
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => ({ version: "0.7.4" }), getURL: (name) => "https://ext/" + name },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { local: { async get() { return storage.seq[Math.min(storage.i++, storage.seq.length - 1)]; }, async set() {}, async remove() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; }, create() {} },
    scripting: { async executeScript() {} }
  };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://ext/")) {
      const bytes = encoder.encode("code-of-" + target.slice("https://ext/".length));
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
    }
    calls.push({ url: target, headers: options.headers || {} });
    if (target.includes("/pair/auto")) return { ok: true, status: 200, json: async () => ({ secret: "s" }), headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => [], headers: { get: () => null } };
  };
  try {
    const background = loadBackground(chrome);
    const hash = await background.extensionCodeHash();
    const inner = ["background.js", "bridge-core.js", "content.js"].map((name) => nodeCrypto.createHash("sha256").update("code-of-" + name).digest());
    const expected = nodeCrypto.createHash("sha256").update(inner[0]).update(inner[1]).update(inner[2]).digest("base64url");
    assert.equal(hash, expected);

    // 等待轮询循环发出 commands 长轮询，指纹必须随请求头一起上报
    let commandsCall = null;
    for (let attempt = 0; attempt < 100 && !commandsCall; attempt += 1) {
      commandsCall = calls.find((call) => call.url.includes("/commands")) || null;
      if (!commandsCall) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(commandsCall, "poll should have issued a commands long-poll");
    assert.equal(commandsCall.headers["X-Extension-Code-Hash"], hash);
    assert.equal(await background.extensionCodeHash(), hash);
  } finally { globalThis.fetch = originalFetch; }
});

test("falls back to the hash-unavailable marker instead of stalling the poll", async () => {
  if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;
  const originalFetch = globalThis.fetch;
  const calls = [];
  const storage = { seq: [{ bridgeSecret: "s" }, {}], i: 0 };
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => ({ version: "0.7.4" }), getURL: () => { throw new Error("unreadable"); } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { local: { async get() { return storage.seq[Math.min(storage.i++, storage.seq.length - 1)]; }, async set() {}, async remove() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; }, create() {} },
    scripting: { async executeScript() {} }
  };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.includes("/commands")) return { ok: true, status: 200, json: async () => ({ secret: "s" }), headers: { get: () => null } };
    calls.push({ url: target, headers: options.headers || {} });
    return { ok: true, status: 200, json: async () => [], headers: { get: () => null } };
  };
  try {
    const background = loadBackground(chrome);
    await assert.equal(await background.extensionCodeHash(), "hash-unavailable");
    // 指纹计算失败也不能堵死轮询：commands 长轮询仍要发出，且带着明确的占位标记
    let commandsCall = null;
    for (let attempt = 0; attempt < 100 && !commandsCall; attempt += 1) {
      commandsCall = calls[0] || null;
      if (!commandsCall) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(commandsCall, "poll loop must keep running when hashing fails");
    assert.equal(commandsCall.headers["X-Extension-Code-Hash"], "hash-unavailable");
  } finally { globalThis.fetch = originalFetch; }
});
