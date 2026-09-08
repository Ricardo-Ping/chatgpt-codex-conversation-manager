// Dump live renderer state over CDP for the dev instance (port 9222)
const base = "http://127.0.0.1:9222";
const list = await (await fetch(`${base}/json/list`)).json();
console.log("targets:", list.map((target) => `${target.type} ${target.url.slice(0, 70)}`));
const page = list.find((target) => target.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

const result = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    statesLabel: !!document.querySelector(".side-states-label"),
    statesText: document.querySelector(".side-states")?.innerText.replace(/\\n/g, " | ") ?? null,
    version: document.querySelector(".side-version")?.textContent ?? null,
    appShell: document.querySelector(".app-shell")?.className ?? null,
    connectionCard: !!document.querySelector(".connection-card"),
    workspace: !!document.querySelector(".workspace"),
    rows: document.querySelectorAll(".row").length,
    bodyText: document.body.innerText.slice(0, 300)
  })`,
  returnByValue: true
});
console.log(result.result.value);
process.exit(0);
