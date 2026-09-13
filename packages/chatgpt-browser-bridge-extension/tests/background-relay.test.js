"use strict";
const test = require("node:test"), assert = require("node:assert/strict");

const RECEIVING_END = "Could not establish connection. Receiving end does not exist.";
const job = (requestId = "r1") => ({ requestId, expiresAt: Date.now() + 60_000, type: "list", payload: {} });

function loadBackground(chrome) { globalThis.chrome = chrome; delete require.cache[require.resolve("../background.js")]; return require("../background.js"); }

function makeHarness({ tab, sendMessage, reload }) {
  const calls = { results: [], messages: [], reload: [] };
  const harness = { stop: false };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/results")) { calls.results.push(JSON.parse(options.body)); return { ok: true, status: 204 }; }
    return { ok: true, status: 200, json: async () => ({ secret: "s" }), headers: { get: () => null } };
  };
  globalThis.chrome = {
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => ({ version: "0.7.9" }), getPlatformInfo: async () => ({}) },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { local: { async get() { return harness.stop ? {} : { bridgeSecret: "s" }; }, async set() {}, async remove() {} } },
    tabs: {
      async query() { return [tab]; },
      sendMessage: async (tabId, message) => { calls.messages.push({ tabId, type: message.type }); return sendMessage(message, tabId); },
      reload: async (tabId) => { calls.reload.push(tabId); if (reload) await reload(); },
      async get(tabId) { return { id: tabId, status: "complete" }; },
      create() {}
    },
    scripting: { async executeScript() {} }
  };
  const background = loadBackground(globalThis.chrome);
  return {
    background, calls, chrome: globalThis.chrome,
    cleanup() { harness.stop = true; globalThis.fetch = originalFetch; }
  };
}

test("auto-reloads an orphaned background tab, then relays the command", async () => {
  let orphan = true;
  const harness = makeHarness({
    tab: { id: 7, active: false, discarded: false },
    sendMessage: async (message) => {
      if (message.type === "ping" && orphan) throw new Error(RECEIVING_END);
      if (message.type !== "ping") assert.equal(orphan, false, "command must wait for the reload to finish");
      return { ok: true, payload: { n: 1 } };
    },
    reload: async () => { orphan = false; }
  });
  try {
    await harness.background.relayJob(job(), "s");
    assert.equal(harness.calls.reload.length, 1);
    assert.equal(harness.calls.results[0].ok, true);
  } finally { harness.cleanup(); }
});

test("leaves a responsive tab alone and still relays the command", async () => {
  const harness = makeHarness({
    tab: { id: 8, active: true, discarded: false },
    sendMessage: async (message) => message.type === "ping" ? { ok: true } : { ok: true, payload: {} }
  });
  try {
    await harness.background.relayJob(job("r2"), "s");
    assert.equal(harness.calls.reload.length, 0);
    assert.equal(harness.calls.results[0].ok, true);
  } finally { harness.cleanup(); }
});

test("asks the user to refresh when an active orphaned tab cannot self-heal", async () => {
  const harness = makeHarness({
    tab: { id: 9, active: true, discarded: false },
    reload: async () => { throw new Error("cannot reload"); },
    sendMessage: async () => { throw new Error(RECEIVING_END); }
  });
  try {
    await harness.background.relayJob(job("r3"), "s");
    const posted = harness.calls.results[0];
    assert.equal(posted.ok, false);
    assert.equal(posted.error.code, "CHATGPT_TAB_UNRESPONSIVE");
    assert.match(posted.error.message, /刷新该标签页以恢复同步/);
  } finally { harness.cleanup(); }
});
