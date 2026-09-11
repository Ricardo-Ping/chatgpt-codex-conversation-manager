import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBridgeServer, ConversationIndexStore, chooseCacheSyncMode } from "./index.js";

const servers: ChatGptBridgeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

async function pairAutomatically(server: ChatGptBridgeServer, port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/pair/auto`, { method: "POST", headers: { Origin: "chrome-extension://test-extension" } });
  expect(response.status).toBe(200);
  const { secret } = await response.json() as { secret: string };
  return secret;
}

describe("ChatGptBridgeServer", () => {
  it("pairs with one extension click and never reissues the secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-bridge-")); const port = 32000 + Math.floor(Math.random() * 1000);
    const server = new ChatGptBridgeServer(join(dir, "secret"), port); servers.push(server); await server.start();
    const denied = await fetch(`http://127.0.0.1:${port}/v1/pair/auto`, { method: "POST" });
    expect(denied.status).toBe(403);
    const response = await fetch(`http://127.0.0.1:${port}/v1/pair/auto`, { method: "POST", headers: { Origin: "chrome-extension://test-extension" } });
    expect(response.status).toBe(200);
    const { secret } = await response.json() as { secret: string };
    expect((await readFile(join(dir, "secret"), "utf8")).trim()).toBe(secret);
    const repeated = await fetch(`http://127.0.0.1:${port}/v1/pair/auto`, { method: "POST", headers: { Origin: "chrome-extension://test-extension" } });
    expect(repeated.status).toBe(409);
    await expect(repeated.json()).resolves.toEqual({ error: "already_paired" });
  });

  it("exposes the expected extension version header for self-reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-bridge-")); const port = 32500 + Math.floor(Math.random() * 400);
    const server = new ChatGptBridgeServer(join(dir, "secret"), port); servers.push(server); await server.start();
    const withoutVersion = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect(withoutVersion.headers.get("x-expected-extension-version")).toBeNull();
    server.setExpectedExtensionVersion("9.9.9");
    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect(health.headers.get("x-expected-extension-version")).toBe("9.9.9");
    expect(health.headers.get("access-control-expose-headers") ?? "").toContain("X-Expected-Extension-Version");
  });

  it("pairs once, rejects bad secrets and resolves commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-bridge-"));
    const port = 33000 + Math.floor(Math.random() * 1000);
    const server = new ChatGptBridgeServer(join(dir, "secret"), port); servers.push(server); await server.start();
    const secret = await pairAutomatically(server, port);
    expect((await readFile(join(dir, "secret"), "utf8")).trim()).toBe(secret);
    expect((await fetch(`http://127.0.0.1:${port}/v1/commands`)).status).toBe(401);
    const pending = server.request("status", {});
    const commands = await fetch(`http://127.0.0.1:${port}/v1/commands`, { headers: { Authorization: `Bearer ${secret}` } });
    const [command] = await commands.json() as Array<{ requestId: string }>;
    await fetch(`http://127.0.0.1:${port}/v1/results`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ protocolVersion: 1, requestId: command!.requestId, ok: true, payload: { loggedIn: true } }) });
    await expect(pending).resolves.toMatchObject({ ok: true, payload: { loggedIn: true } });
  });

  it("removes timed-out commands before the browser can execute them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-bridge-")); const port = 35000 + Math.floor(Math.random() * 1000);
    const server = new ChatGptBridgeServer(join(dir, "secret"), port); servers.push(server); await server.start();
    const secret = await pairAutomatically(server, port);
    await expect(server.request("batch", { action: "delete" }, 10)).rejects.toThrow("timed out");
    const commands = await fetch(`http://127.0.0.1:${port}/v1/commands`, { headers: { Authorization: `Bearer ${secret}` } });
    await expect(commands.json()).resolves.toEqual([]);
  });

  it("serves authenticated local commands without marking the extension connected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-local-")); const port = 36000 + Math.floor(Math.random() * 1000);
    const server = new ChatGptBridgeServer(join(dir, "secret"), port); servers.push(server); await server.start();
    const secret = await pairAutomatically(server, port);
    const seen: Array<{ type: string; payload: unknown }> = [];
    server.setLocalHandler(async (type, payload) => { seen.push({ type, payload }); return { echo: type, connected: server.state().connected };
    });

    const denied = await fetch(`http://127.0.0.1:${port}/v1/local`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "chatgpt.search" }) });
    expect(denied.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${port}/v1/local`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: "chatgpt.search", payload: { query: "sql" } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; result: { echo: string; connected: boolean } };
    expect(body.ok).toBe(true);
    expect(body.result.echo).toBe("chatgpt.search");
    expect(body.result.connected).toBe(false);
    expect(seen[0]).toMatchObject({ type: "chatgpt.search", payload: { query: "sql" } });
    expect(server.state().connected).toBe(false);
  });

  it("exposes the loaded secret through secretText for endpoint discovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-secret-")); const port = 37000 + Math.floor(Math.random() * 1000);
    const server = new ChatGptBridgeServer(join(dir, "secret"), port); servers.push(server);
    const changes: Array<string | null> = [];
    server.onSecretChange((secret) => changes.push(secret));
    await server.start();
    expect(server.secretText()).toBeNull();
    expect(changes).toEqual([null]);
    const secret = await pairAutomatically(server, port);
    expect(server.secretText()).toBe(secret);
    expect(changes[changes.length - 1]).toBe(secret);
  });
});

describe("ConversationIndexStore", () => {
  it("uses cached incremental sync until periodic full calibration is due", () => {
    const now = Date.parse("2026-09-08T00:00:00Z");
    const snapshot = { syncedAt: now, fullSyncedAt: now, records: [] };
    expect(chooseCacheSyncMode(null, false, now)).toBe("full");
    expect(chooseCacheSyncMode(snapshot, false, now + 5 * 60 * 60 * 1000)).toBe("incremental");
    expect(chooseCacheSyncMode(snapshot, false, now + 6 * 60 * 60 * 1000)).toBe("full");
    expect(chooseCacheSyncMode(snapshot, true, now)).toBe("full");
  });

  it("removes server-deleted records during periodic full calibration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-cache-")); const store = new ConversationIndexStore(join(dir, "index.json")); await store.load();
    const record = (id: string) => ({ id, title: id, createdAt: 1, updatedAt: 2, state: "active" as const, pinned: false, current: false, automation: false });
    await store.replace("account", "默认账号", "active", [record("kept"), record("removed-remotely")], true);
    await store.replace("account", "默认账号", "active", [record("kept")], true);
    expect(store.read("account", "active")?.records.map((item) => item.id)).toEqual(["kept"]);
    expect(store.stats().lastFullSyncedAt).not.toBeNull();
  });

  it("holds the commands long-poll until a command is queued", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-bridge-"));
    const port = 33000 + Math.floor(Math.random() * 1000);
    const server = new ChatGptBridgeServer(join(dir, "secret"), port); servers.push(server); await server.start();
    const secret = await pairAutomatically(server, port);
    const startedAt = Date.now();
    const poll = fetch(`http://127.0.0.1:${port}/v1/commands?wait=3`, { headers: { Authorization: `Bearer ${secret}` } }).then((response) => response.json() as Promise<Array<{ requestId: string }>>);
    server.request("list", { mode: "incremental", checkpoint: null }).catch(() => {});
    const commands = await poll;
    expect(commands.length).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it("moves and deletes only server-confirmed records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-cache-")); const store = new ConversationIndexStore(join(dir, "index.json")); await store.load();
    await store.replace("account", "默认账号", "active", [{ id: "one", title: "One", createdAt: 1, updatedAt: 2, state: "active", pinned: false, current: false, automation: false }], true);
    await store.apply("account", "archive", ["one"]);
    expect(store.read("account", "active")?.records).toEqual([]);
    expect(store.read("account", "archived")?.records[0]?.state).toBe("archived");
    await store.apply("account", "delete", ["one"]);
    expect(store.read("account", "archived")?.records).toEqual([]);
  });

  it("keeps the project id when a later sync returns an untagged copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-cache-")); const store = new ConversationIndexStore(join(dir, "index.json")); await store.load();
    await store.replace("account", "默认账号", "active", [{ id: "proj-one", title: "Project task", createdAt: 1, updatedAt: 2, state: "active", projectId: "proj-1", pinned: false, current: false, automation: false }], true);
    await store.merge("account", "默认账号", "active", [{ id: "proj-one", title: "Project task", createdAt: 1, updatedAt: 3, state: "active", pinned: false, current: false, automation: false }]);
    expect(store.read("account", "active")?.records[0]?.projectId).toBe("proj-1");
  });

  it("stores project names per account and serves them with every state snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-cache-")); const store = new ConversationIndexStore(join(dir, "index.json")); await store.load();
    const record = { id: "one", title: "One", createdAt: 1, updatedAt: 2, state: "active" as const, projectId: "g-p-1", pinned: false, current: false, automation: false };
    await store.replace("account", "默认账号", "active", [record], true, { "g-p-1": "调研项目" });
    await store.replace("account", "默认账号", "archived", [], true);
    expect(store.read("account", "active")?.projects).toEqual({ "g-p-1": "调研项目" });
    expect(store.read("account", "archived")?.projects).toEqual({ "g-p-1": "调研项目" });
  });

  it("does not revive a recently confirmed deletion during full calibration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-cache-")); const store = new ConversationIndexStore(join(dir, "index.json")); await store.load();
    const record = { id: "gone", title: "Gone", createdAt: 1, updatedAt: 2, state: "active" as const, pinned: false, current: false, automation: false };
    await store.replace("account", "默认账号", "active", [record], true); await store.apply("account", "delete", ["gone"]); await store.replace("account", "默认账号", "active", [record], true);
    expect(store.read("account", "active")?.records).toEqual([]);
  });

  it("lets newer incremental records replace stale cached values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-cache-")); const store = new ConversationIndexStore(join(dir, "index.json")); await store.load();
    const record = { id: "same", title: "Old", createdAt: 1, updatedAt: 2, state: "active" as const, pinned: false, current: false, automation: false };
    await store.replace("account", "默认账号", "active", [record], true);
    await store.merge("account", "默认账号", "active", [{ ...record, title: "New", updatedAt: 3 }]);
    expect(store.read("account", "active")?.records[0]).toMatchObject({ title: "New", updatedAt: 3 });
  });
});
