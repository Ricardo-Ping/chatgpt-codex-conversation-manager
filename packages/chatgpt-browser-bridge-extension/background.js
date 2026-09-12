"use strict";
const BASE = "http://127.0.0.1:32147/v1";
let polling = false;
let keepAliveTimer = null;
let inFlightCommands = 0;

const CODE_FILES = ["background.js", "bridge-core.js", "content.js"];
let codeHashPromise = null;
// 启动代码指纹：SW 启动即从磁盘加载这三个文件，进程生命周期内只算一次。
// 桌面端把它与"当前磁盘内容"的指纹比对，可发现版本号没变但文件已被自愈覆写的情况
//（旧 SW 跑着旧代码、版本号却相同——纯版本比对永远发现不了）。
function extensionCodeHash() {
  if (!codeHashPromise) {
    codeHashPromise = (async () => {
      try {
        const digests = [];
        for (const name of CODE_FILES) {
          const response = await fetch(chrome.runtime.getURL(name));
          if (!response.ok) return "hash-unavailable";
          digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", await response.arrayBuffer())));
        }
        const combined = new Uint8Array(digests.length * 32);
        digests.forEach((digest, index) => combined.set(digest, index * 32));
        return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", combined)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      } catch { return "hash-unavailable"; }
    })();
  }
  return codeHashPromise;
}

// MV3 会在空闲约 30 秒后休眠 Service Worker；长命令执行期间通过定期调用扩展 API 重置空闲计时器
function beginKeepAlive() {
  inFlightCommands += 1;
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20_000);
}
let pendingSelfReloadTarget = null;
function endKeepAlive() {
  inFlightCommands = Math.max(0, inFlightCommands - 1);
  if (inFlightCommands === 0 && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  // 忙时被推迟的自动重载：命令队列清空后立即补上，绝不让"正在执行命令"跳过升级
  if (inFlightCommands === 0 && pendingSelfReloadTarget) { const target = pendingSelfReloadTarget; pendingSelfReloadTarget = null; void requestSelfReload(target); }
}

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
  void maybeSelfReload(response);
  const body = await response.json();
  if (!response.ok || !body.secret) throw new Error(body.error === "already_paired" ? "桌面端已与其他扩展配对，请先在设置中清除配对 / The desktop app is already paired — clear pairing in the desktop settings" : body.error || "Pairing failed / 配对失败");
  await chrome.storage.local.set({ bridgeSecret: body.secret }); void startPolling(); return { ok: true };
}
const CHATGPT_TAB_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const { query: findChatGptTabs } = chrome.tabs;
async function status() {
  const stored = await chrome.storage.local.get("bridgeSecret");
  const paired = Boolean(stored.bridgeSecret);
  let desktop = false;
  try {
    const health = await fetch(BASE + "/health");
    desktop = health.ok;
  } catch {}
  let chatgptOpen = false;
  try {
    const openTabs = await findChatGptTabs({ url: CHATGPT_TAB_PATTERNS });
    chatgptOpen = openTabs.length > 0;
  } catch {}
  return { paired, desktop, chatgptOpen };
}
function versionParts(value) {
  const core = String(value).trim().replace(/^v/i, "").split("-")[0];
  const rawParts = core.split(".");
  return rawParts.map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}
function isNewerVersion(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}
// 桌面端更新后会在响应头里带期望的扩展版本；扩展发现自己落后且磁盘文件已是新版时，自我 reload 完成升级
async function requestSelfReload(target) {
  try {
    const stored = await chrome.storage.local.get("lastSelfReloadTarget");
    if (stored.lastSelfReloadTarget === target) return;
    await chrome.storage.local.set({ lastSelfReloadTarget: target });
    chrome.runtime.reload();
  } catch {}
}
async function maybeSelfReload(response) {
  try {
    const target = response.headers.get("x-expected-extension-version");
    if (!target) return;
    const running = chrome.runtime.getManifest().version;
    if (!isNewerVersion(target, running)) return;
    // 正在执行命令时不打断当前任务：记下目标，命令队列清空后立即补上（endKeepAlive）
    if (inFlightCommands > 0) { pendingSelfReloadTarget = target; return; }
    void requestSelfReload(target);
  } catch {}
}
async function startPolling() {
  if (polling) return; polling = true;
  let delay = 1500;
  try {
    for (;;) {
      let { bridgeSecret } = await chrome.storage.local.get("bridgeSecret");
      if (!bridgeSecret) { try { await pair(); ({ bridgeSecret } = await chrome.storage.local.get("bridgeSecret")); } catch {} }
      if (!bridgeSecret) break;
      try {
        const authorization = "Bearer " + bridgeSecret;
        const commandsUrl = `${BASE}/commands?wait=10`;
        // 指纹计算竞速 3 秒兜底：绝不能让轮询循环因指纹未就绪而停摆
        const headers = { Authorization: authorization, "X-Extension-Version": chrome.runtime.getManifest().version };
        const codeHash = await Promise.race([extensionCodeHash(), wait(3000).then(() => null)]);
        if (codeHash) headers["X-Extension-Code-Hash"] = codeHash;
        const response = await fetch(commandsUrl, { headers });
        // 桌面端要求硬重载：磁盘上的扩展文件比运行中的 SW 新（桌面端判定版本落后时才会带此头），
        // 立即重启 SW 加载新代码——此检查必须先于任务入队，避免被挂死任务阻塞
        if (response.headers.get("x-reload-extension") === "1") { chrome.runtime.reload(); return; }
        void maybeSelfReload(response);
        if (response.status === 401) { await chrome.storage.local.remove("bridgeSecret"); break; }
        if (response.ok) { delay = 1500; for (const job of await response.json()) enqueueRelay(job, bridgeSecret); }
        else delay = 5000;
      } catch { delay = 5000; }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } finally { polling = false; }
}
async function relayJob(job, secret) {
  beginKeepAlive();
  let result;
  // 命令活性心跳：执行期间每 15 秒向桌面端报告"命令仍在推进"。
  // 桌面端据此刷新超时窗口——完整校准/项目多时的慢同步不再被固定预算误杀；
  // 命令结束或 SW 卡死时心跳停止，桌面端窗口到期才超时兜底。
  const heartbeat = setInterval(() => { void reportProgress(job.requestId, secret); }, 15_000);
  try {
    if (!Number.isFinite(job?.expiresAt) || job.expiresAt <= Date.now()) throw new Error("桌面命令已过期，未执行 / Desktop command expired");
    const tabs = await findChatGptTabs({ url: CHATGPT_TAB_PATTERNS });
    // 优先最近使用的标签页；被 Chrome 冻结/休眠的旧标签页可能永远不应答，最多尝试两个后快速失败
    const ordered = tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, 2);
    if (!ordered.length) {
      result = { ok: false, error: { code: "NO_CHATGPT_TAB", message: "请先在浏览器打开 ChatGPT / Please open chatgpt.com in your browser first", retryable: true } };
    } else {
      let lastError = null;
      for (const tab of ordered) {
        try { result = await sendToChatGptTab(tab.id, { target: "conversation-manager-content", ...job }); break; }
        catch (error) { lastError = error; }
      }
      if (result === null) result = { ok: false, error: { code: "CHATGPT_TAB_UNRESPONSIVE", message: (lastError && lastError.message) || "ChatGPT 页面长时间无响应，请刷新 ChatGPT 标签页后重试 / The ChatGPT tab is not responding — refresh it and retry", retryable: true } };
    }
  } catch (error) { result = { ok: false, error: { code: "INTERNAL_ERROR", message: error.message || String(error), retryable: true } }; }
  clearInterval(heartbeat);
  try { await reportResult(job, secret, result); } finally { endKeepAlive(); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let relayQueue = Promise.resolve();
let fastQueue = Promise.resolve();
// 批量变更并入慢队列：写操作与长同步错峰，避免在同一 ChatGPT 页面并发争用触发 429；
// cancel/status/projects/read 保持快速通道（cancel 必须能及时取消，read 单发无并发压力）
const FAST_COMMANDS = new Set(["cancel", "status", "projects", "read"]);
function enqueueRelay(job, secret) {
  // 入队前先判过期：轮到时早已失效的命令不进队列，立即回报桌面端快速失败——
  // 否则它会占住串行队列位置，桌面端还要再等满整个超时预算才报错
  if (!Number.isFinite(job?.expiresAt) || job.expiresAt <= Date.now()) {
    void reportResult(job, secret, { ok: false, error: { code: "COMMAND_EXPIRED", message: "桌面命令已过期，未执行 / Desktop command expired", retryable: true } });
    return;
  }
  // 同步与导出等慢速读命令串行转发，避免在 ChatGPT 端并发竞争导致超时
  if (FAST_COMMANDS.has(job?.type)) fastQueue = fastQueue.then(() => relayJob(job, secret)).catch(() => {});
  else relayQueue = relayQueue.then(() => relayJob(job, secret)).catch(() => {});
}
async function reportResult(job, secret, result) {
  try { await fetch(`${BASE}/results`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: 1, requestId: job.requestId, ...result }) }); } catch {}
}
// 旧桌面端不认识 /v1/progress 会返回 404，吞掉即可；心跳失败不影响命令本身
async function reportProgress(requestId, secret) {
  try { await fetch(`${BASE}/progress`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: 1, requestId }) }); } catch {}
}
// 单次页面消息限时 60 秒：被 Chrome 冻结/休眠的标签页可能永远不应答，
// 无超时会卡死转发队列，让桌面端每次读取都等满整个超时预算
const TAB_RESPONSE_TIMEOUT_MS = 60_000;
function sendWithTimeout(tabId, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ChatGPT 页面 60 秒无响应（可能已被 Chrome 冻结），请刷新该标签页后重试 / The ChatGPT tab is frozen — refresh it and retry")), TAB_RESPONSE_TIMEOUT_MS);
    chrome.tabs.sendMessage(tabId, message).then((response) => { clearTimeout(timer); resolve(response); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
async function sendToChatGptTab(tabId, message) {
  let lastError = null;
  try { return await sendWithTimeout(tabId, message); }
  catch (error) {
    if (!/receiving end does not exist|could not establish connection/i.test(error?.message || String(error))) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["bridge-core.js", "content.js"] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await wait(300 * (attempt + 1));
      try { return await sendWithTimeout(tabId, message); } catch (retryError) {
        lastError = retryError;
        if (attempt === 2 || !/receiving end does not exist|could not establish connection/i.test(retryError?.message || String(retryError))) throw retryError;
      }
    }
    throw new Error("Receiving end does not exist", { cause: lastError });
  }
}

void startPolling();

if (typeof module !== "undefined" && module?.exports) module.exports = { sendToChatGptTab, extensionCodeHash };
