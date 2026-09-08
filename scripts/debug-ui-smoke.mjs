// Dev UI smoke test: drives the running dev app over CDP (launch electron with --remote-debugging-port=9222)
const base = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const list = await (await fetch(`${base}/json/list`)).json();
const page = list.find((target) => target.type === "page" && target.url.includes("index.html"));
if (!page) throw new Error("app page not found: " + JSON.stringify(list.map((t) => t.url)));

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

async function evalJs(expression) {
  const result = await send("Runtime.evaluate", { expression: `JSON.stringify((${expression}) ?? null)`, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
  return JSON.parse(result.result.value);
}

const results = {};
results.version = await evalJs(`document.querySelector(".side-version")?.textContent`);
results.defaultStatesLabel = await evalJs(`document.querySelector(".side-states-label")?.textContent`);

// language switch zh -> en -> zh
await evalJs(`window.conversationManager.setAppLanguage("en")`);
await sleep(200);
results.enStatesLabel = await evalJs(`document.querySelector(".side-states-label")?.textContent`);
results.enFirstState = await evalJs(`document.querySelector(".side-states .segments.vertical button")?.textContent`);
results.enBridgeStatus = await evalJs(`document.querySelector(".side-status p strong")?.textContent`);
await evalJs(`window.conversationManager.setAppLanguage("zh")`);
await sleep(200);
results.zhStatesLabel = await evalJs(`document.querySelector(".side-states-label")?.textContent`);

// navigate to settings
await evalJs(`[...document.querySelectorAll(".side-footer button")].forEach((b) => b.click())`);
await sleep(250);
results.settingsTitle = await evalJs(`document.querySelector(".settings h1")?.textContent`);
results.themeSegmented = await evalJs(`document.querySelector(".settings .segments")?.textContent`);
results.logCardExists = Boolean(await evalJs(`!!document.querySelector(".log-view")`));
// language switch inside settings back to en then zh
await evalJs(`[...document.querySelectorAll(".card-actions .segments.vertical button, .card-actions .segments button")].map((b, i) => { if (b.textContent === "English") b.click(); })`);
await sleep(250);
results.settingsTitleEn = await evalJs(`document.querySelector(".settings h1")?.textContent`);
await evalJs(`[...document.querySelectorAll(".card-actions .segments button")].find((b) => b.textContent === "中文")?.click()`);
await sleep(250);
results.settingsTitleZh = await evalJs(`document.querySelector(".settings h1")?.textContent`);
// back to chats
await evalJs(`[...document.querySelectorAll(".side-nav button")].find((b) => b.textContent.trim() === "ChatGPT")?.click()`);
await sleep(300);
results.rows = await evalJs(`document.querySelectorAll(".row").length`);
results.refreshBtn = await evalJs(`document.querySelector(".title-actions .refresh")?.textContent`);
results.saveBtn = await evalJs(`document.querySelector(".primary-actions .secondary")?.textContent`);

console.log(JSON.stringify(results, null, 2));
