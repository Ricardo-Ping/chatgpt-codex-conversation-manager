import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 32147;
export const PROTOCOL_VERSION = 1;
const MAX_BODY = 1_000_000;

export type BridgeCommandType = "status" | "accounts" | "list" | "batch" | "cancel";
export interface BridgeCommand { protocolVersion: 1; requestId: string; type: BridgeCommandType; createdAt: number; expiresAt: number; payload: unknown }
export interface BridgeError { code: string; message: string; retryable: boolean }
export interface BridgeResult { protocolVersion: 1; requestId: string; ok: boolean; payload?: unknown; error?: BridgeError }
export interface PairingState { paired: boolean; connected: boolean; code: string | null; expiresAt: number | null }

type Pending = { resolve(value: BridgeResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class ChatGptBridgeServer {
  readonly #secretFile: string;
  readonly #port: number;
  #server: Server | null = null;
  #secret: Buffer | null = null;
  #pairing: { code: string; expiresAt: number; failures: number } | null = null;
  #commands: BridgeCommand[] = [];
  #pending = new Map<string, Pending>();
  #lastSeen = 0;

  constructor(secretFile: string, port = BRIDGE_PORT) { this.#secretFile = secretFile; this.#port = port; }

  async start(): Promise<void> {
    if (this.#server) return;
    try { this.#secret = Buffer.from((await readFile(this.#secretFile, "utf8")).trim(), "base64url"); } catch { this.#secret = null; }
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#port, BRIDGE_HOST, () => { this.#server!.off("error", reject); resolve(); });
    });
  }

  async close(): Promise<void> {
    for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(new Error("Bridge closed")); }
    this.#pending.clear();
    this.#commands = [];
    const server = this.#server; this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  beginPairing(now = Date.now()): PairingState {
    this.#pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: now + 300_000, failures: 0 };
    return this.state(now);
  }

  state(now = Date.now()): PairingState {
    if (this.#pairing && this.#pairing.expiresAt <= now) this.#pairing = null;
    return { paired: Boolean(this.#secret), connected: now - this.#lastSeen < 15_000, code: this.#pairing?.code ?? null, expiresAt: this.#pairing?.expiresAt ?? null };
  }

  async clearPairing(): Promise<void> { this.#secret = null; this.#pairing = null; await rm(this.#secretFile, { force: true }); }

  request(type: BridgeCommandType, payload: unknown, timeoutMs = 60_000): Promise<BridgeResult> {
    const requestId = randomBytes(16).toString("hex");
    const createdAt = Date.now();
    const command: BridgeCommand = { protocolVersion: 1, requestId, type, createdAt, expiresAt: createdAt + timeoutMs, payload };
    this.#commands.push(command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); this.#commands = this.#commands.filter((item) => item.requestId !== requestId); reject(new Error("Browser bridge request timed out")); }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "GET" && req.url === "/v1/health") { const state = this.state(); return json(res, 200, { protocolVersion: 1, paired: state.paired, connected: state.connected }); }
      if (req.method === "POST" && req.url === "/v1/pair/auto") { if (!isExtensionOrigin(req.headers.origin)) return json(res, 403, { error: "invalid_origin" }); return await this.#pairAutomatically(res); }
      if (req.method === "POST" && req.url === "/v1/pair") { const origin = req.headers.origin; if (origin && !isExtensionOrigin(origin)) return json(res, 403, { error: "invalid_origin" }); return await this.#pair(req, res); }
      if (!this.#authorize(req)) return json(res, 401, { error: "unauthorized" });
      this.#lastSeen = Date.now();
      if (req.method === "GET" && req.url === "/v1/commands") return json(res, 200, this.#commands.splice(0, 20));
      if (req.method === "POST" && req.url === "/v1/results") {
        const result = await readJson<BridgeResult>(req);
        if (result.protocolVersion !== 1 || typeof result.requestId !== "string" || typeof result.ok !== "boolean") return json(res, 400, { error: "invalid_result" });
        const pending = this.#pending.get(result.requestId);
        if (pending) { this.#pending.delete(result.requestId); clearTimeout(pending.timer); pending.resolve(result); }
        return json(res, 204, null);
      }
      json(res, 404, { error: "not_found" });
    } catch (error) { json(res, error instanceof BodyError ? error.status : 500, { error: error instanceof Error ? error.message : "internal_error" }); }
  }

  async #pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<{ code?: unknown }>(req);
    const now = Date.now();
    if (!this.#pairing || this.#pairing.expiresAt <= now || this.#pairing.failures >= 5) { this.#pairing = null; return json(res, 410, { error: "pairing_expired" }); }
    if (typeof body.code !== "string" || body.code !== this.#pairing.code) {
      this.#pairing.failures += 1;
      if (this.#pairing.failures >= 5) this.#pairing = null;
      return json(res, 403, { error: "invalid_code" });
    }
    this.#secret = randomBytes(32);
    await mkdir(dirname(this.#secretFile), { recursive: true });
    await writeFile(this.#secretFile, this.#secret.toString("base64url"), { encoding: "utf8", mode: 0o600 });
    this.#pairing = null;
    json(res, 200, { protocolVersion: 1, secret: this.#secret.toString("base64url") });
  }

  async #pairAutomatically(res: ServerResponse): Promise<void> {
    if (this.#secret) return json(res, 409, { error: "already_paired" });
    this.#secret = randomBytes(32);
    await mkdir(dirname(this.#secretFile), { recursive: true });
    await writeFile(this.#secretFile, this.#secret.toString("base64url"), { encoding: "utf8", mode: 0o600 });
    this.#pairing = null;
    json(res, 200, { protocolVersion: 1, secret: this.#secret.toString("base64url") });
  }

  #authorize(req: IncomingMessage): boolean {
    const value = req.headers.authorization;
    if (!this.#secret || !value?.startsWith("Bearer ")) return false;
    let candidate: Buffer;
    try { candidate = Buffer.from(value.slice(7), "base64url"); } catch { return false; }
    return candidate.length === this.#secret.length && timingSafeEqual(candidate, this.#secret);
  }
}

class BodyError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > MAX_BODY) throw new BodyError(413, "body_too_large"); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as T; } catch { throw new BodyError(400, "invalid_json"); }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  if (status === 204) return void res.end();
  const body: string = JSON.stringify(value) ?? "null";
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(Buffer.from(body, "utf8"));
}
function isExtensionOrigin(origin: string | undefined): boolean { return Boolean(origin?.startsWith("chrome-extension://") || origin?.startsWith("extension://")); }

export interface CachedConversation { id: string; title: string; createdAt: number | null; updatedAt: number | null; state: "active" | "archived" | "scheduled"; projectId?: string; pinned: boolean; current: boolean; automation: boolean }
interface CacheFile { schemaVersion: 1; accounts: Record<string, { label: string; mutations?: Record<string, { action: "archive" | "restore" | "delete"; at: number }>; states: Partial<Record<CachedConversation["state"], { syncedAt: number; fullSyncedAt: number | null; records: CachedConversation[] }>> }> }

export class ConversationIndexStore {
  readonly #file: string;
  #data: CacheFile = { schemaVersion: 1, accounts: {} };
  constructor(file: string) { this.#file = file; }
  async load(): Promise<void> { try { const value = JSON.parse(await readFile(this.#file, "utf8")) as CacheFile; this.#data = value.schemaVersion === 1 && value.accounts && typeof value.accounts === "object" ? value : { schemaVersion: 1, accounts: {} }; } catch { this.#data = { schemaVersion: 1, accounts: {} }; } }
  accounts(): Array<{ key: string; label: string }> { return Object.entries(this.#data.accounts).map(([key, value]) => ({ key, label: value.label })); }
  stats(): { accounts: number; records: number; bytes: number; lastSyncedAt: number | null } { const states = Object.values(this.#data.accounts).flatMap((account) => Object.values(account.states).filter((state): state is NonNullable<typeof state> => Boolean(state))); return { accounts: Object.keys(this.#data.accounts).length, records: states.reduce((sum, state) => sum + state.records.length, 0), bytes: Buffer.byteLength(JSON.stringify(this.#data)), lastSyncedAt: states.reduce<number | null>((latest, state) => latest === null || state.syncedAt > latest ? state.syncedAt : latest, null) }; }
  read(accountKey: string, state: CachedConversation["state"]): { syncedAt: number; fullSyncedAt: number | null; records: CachedConversation[] } | null { const value = this.#data.accounts[accountKey]?.states[state]; return value ? structuredClone(value) : null; }
  async replace(accountKey: string, label: string, state: CachedConversation["state"], records: CachedConversation[], full: boolean): Promise<void> {
    const account = this.#data.accounts[accountKey] ??= { label, states: {} }; account.label = label;
    const now = Date.now(); const mutations = account.mutations ??= {}; for (const [id, mutation] of Object.entries(mutations)) if (now - mutation.at > 600_000) delete mutations[id];
    const filtered = records.filter((record) => { const mutation = mutations[record.id]; if (!mutation) return true; if (mutation.action === "delete") return false; const expected = mutation.action === "archive" ? "archived" : "active"; if (record.state === expected) { delete mutations[record.id]; return true; } return false; });
    account.states[state] = { syncedAt: now, fullSyncedAt: full ? now : account.states[state]?.fullSyncedAt ?? null, records: dedupe(filtered) }; await this.#save();
  }
  async merge(accountKey: string, label: string, state: CachedConversation["state"], records: CachedConversation[]): Promise<void> {
    const old = this.read(accountKey, state)?.records ?? [];
    await this.replace(accountKey, label, state, dedupe([...old, ...records]), false);
  }
  async apply(accountKey: string, action: "archive" | "restore" | "delete", succeeded: string[]): Promise<void> {
    const account = this.#data.accounts[accountKey]; if (!account) return; const ids = new Set(succeeded); const now = Date.now(); const mutations = account.mutations ??= {}; for (const id of ids) mutations[id] = { action, at: now };
    const active = account.states.active; const archived = account.states.archived;
    if (action === "delete") {
      for (const state of Object.values(account.states)) if (state) state.records = state.records.filter((item) => !ids.has(item.id));
    } else {
      const from = action === "archive" ? active : archived; const toState: "active" | "archived" = action === "archive" ? "archived" : "active"; const to = account.states[toState] ??= { syncedAt: Date.now(), fullSyncedAt: null, records: [] };
      const moved = from?.records.filter((item) => ids.has(item.id)) ?? []; if (from) from.records = from.records.filter((item) => !ids.has(item.id)); to.records = dedupe([...moved.map((item) => ({ ...item, state: toState })), ...to.records]);
    }
    await this.#save();
  }
  async clear(): Promise<void> { this.#data = { schemaVersion: 1, accounts: {} }; await this.#save(); }
  async #save(): Promise<void> { await mkdir(dirname(this.#file), { recursive: true }); const temp = `${this.#file}.tmp`; await writeFile(temp, `${JSON.stringify(this.#data)}\n`, "utf8"); await rename(temp, this.#file); }
}
function dedupe(records: CachedConversation[]): CachedConversation[] { return [...new Map(records.map((item) => [item.id, item])).values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)); }
export function accountKey(rawId: string): string { return createHash("sha256").update(rawId).digest("hex"); }
