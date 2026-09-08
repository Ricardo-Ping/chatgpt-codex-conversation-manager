// Drive real UI clicks: open settings, switch language to English, verify, switch back
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const list = await (await fetch(`${base}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

const evalText = async (selector) => {
  const result = await send("Runtime.evaluate", { expression: `JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent ?? null)`, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
  return JSON.parse(result.result.value);
};
const clickButton = async (selector, matchText) => {
  const result = await send("Runtime.evaluate", { expression: `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim().includes(${JSON.stringify(matchText)})); if (!el) throw new Error("button not found: " + ${JSON.stringify(selector)}); el.click(); return true; })()`, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "click failed");
};

const snap = `JSON.stringify({
  states: [...document.querySelectorAll(".side-states .segments.vertical button")].map((b) => b.textContent.trim()).join("|"),
  settings: [...document.querySelectorAll(".side-footer button")].map((b) => b.textContent.trim()).join("|"),
  bridge: document.querySelector(".side-status p strong")?.textContent ?? null,
  title: document.querySelector(".settings h1")?.textContent ?? null
})`;

const results = {};

// open settings
await clickButton(".side-footer button", "设置");
await sleep(300);
results.settingsOpened = await evalText(".settings h1");

// switch to English
await clickButton(".card-actions .segments button", "English");
await sleep(400);
results.afterEn = { title: await evalText(".settings h1"), states: await evalText(".side-states .segments.vertical") };

// switch back to Chinese
await clickButton(".card-actions .segments button", "中文");
await sleep(400);
results.afterZh = { title: await evalText(".settings h1"), states: await evalText(".side-states .segments.vertical") };

// sidebar snapshot
results.sidebarBridge = await evalText(".side-status p strong");
results.sidebarStates = await evalText(".side-states .segments.vertical");

console.log(JSON.stringify(results, null, 2));
process.exit(0);
