"use strict";
const BASE = "http://127.0.0.1:32147/v1";
let polling = false;

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create("conversation-manager-poll", { periodInMinutes: 0.5 }); void startPolling(); });
chrome.runtime.onStartup.addListener(() => void startPolling());
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "conversation-manager-poll") void startPolling(); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "pair") { pair().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "bridge-status") { status().then(sendResponse); return true; }
  if (message?.type === "open-chatgpt") { chrome.tabs.create({ url: "https://chatgpt.com/", active: true }); sendResponse({ ok: true }); return false; }
});

async function pair() {
  const response = await fetch(`${BASE}/pair/auto`, { method: "POST" });
  const body = await response.json();
  if (!response.ok || !body.secret) throw new Error(body.error === "already_paired" ? "桌面端已与其他扩展配对，请先在设置中清除配对" : body.error || "配对失败");
  await chrome.storage.local.set({ bridgeSecret: body.secret }); void startPolling(); return { ok: true };
}
async function status() {
  const { bridgeSecret } = await chrome.storage.local.get("bridgeSecret");
  let desktop = false; try { desktop = (await fetch(`${BASE}/health`)).ok; } catch {}
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  return { paired: Boolean(bridgeSecret), desktop, chatgptOpen: tabs.length > 0 };
}
async function startPolling() {
  if (polling) return; polling = true;
  let delay = 1500;
  try {
    for (;;) {
      const { bridgeSecret } = await chrome.storage.local.get("bridgeSecret"); if (!bridgeSecret) break;
      try {
        const response = await fetch(`${BASE}/commands`, { headers: { Authorization: `Bearer ${bridgeSecret}` } });
        if (response.status === 401) { await chrome.storage.local.remove("bridgeSecret"); break; }
        if (response.ok) { delay = 1500; for (const command of await response.json()) void run(command, bridgeSecret); }
        else delay = 5000;
      } catch { delay = 5000; }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } finally { polling = false; }
}
async function run(command, secret) {
  let result;
  try {
    if (!Number.isFinite(command?.expiresAt) || command.expiresAt <= Date.now()) throw new Error("桌面命令已过期，未执行");
    const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
    const tab = tabs[0];
    if (!tab?.id) result = { ok: false, error: { code: "NO_CHATGPT_TAB", message: "请先在浏览器打开 ChatGPT", retryable: true } };
    else result = await sendToChatGptTab(tab.id, { target: "conversation-manager-content", ...command });
  } catch (error) { result = { ok: false, error: { code: "INTERNAL_ERROR", message: error.message || String(error), retryable: true } }; }
  await fetch(`${BASE}/results`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: 1, requestId: command.requestId, ...result }) });
}
async function sendToChatGptTab(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (error) {
    if (!/receiving end does not exist|could not establish connection/i.test(error?.message || String(error))) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["bridge-core.js", "content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}
void startPolling();
