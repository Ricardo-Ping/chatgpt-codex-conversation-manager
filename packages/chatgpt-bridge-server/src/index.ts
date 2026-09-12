import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 32147;
export const PROTOCOL_VERSION = 1;
const MAX_BODY = 8_000_000;

export type BridgeCommandType = "status" | "accounts" | "list" | "batch" | "cancel" | "read" | "projects";
export interface BridgeCommand { protocolVersion: 1; requestId: string; type: BridgeCommandType; createdAt: number; expiresAt: number; payload: unknown }
export interface BridgeError { code: string; message: string; retryable: boolean }
export interface BridgeResult { protocolVersion: 1; requestId: string; ok: boolean; payload?: unknown; error?: BridgeError }
export interface PairingState { paired: boolean; connected: boolean; extensionVersion: string | null }

type Pending = { resolve(value: BridgeResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; timeoutMs: number };

export class ChatGptBridgeServer {
  readonly #secretFile: string;
  readonly #port: number;
  #server: Server | null = null;
  #secret: Buffer | null = null;
  #boundPort: number | null = null;
  #commands: BridgeCommand[] = [];
  #pending = new Map<string, Pending>();
  #lastSeen = 0;
  #extensionVersion: string | null = null;
  #extensionCodeHash: string | null = null;
  #expectedExtensionVersion: string | null = null;
  #localHandler: ((type: string, payload: unknown) => Promise<unknown>) | null = null;
  #onSecretChange: ((secret: string | null) => void) | null = null;
  #reloadHint = false;

  constructor(secretFile: string, port = BRIDGE_PORT) { this.#secretFile = secretFile; this.#port = port; }

  // 桌面端把自己打包的扩展版本号告诉扩展，扩展发现落后即可自行 reload 升级
  setExpectedExtensionVersion(version: string | null): void { this.#expectedExtensionVersion = version; }

  // 扩展轮询时上报的自身版本（可能因 SW 长期存活而落后于磁盘文件）
  reportedVersion(): string | null { return this.#extensionVersion; }

  // 扩展轮询时上报的启动代码指纹（启动时磁盘内容的哈希）。桌面端与当前磁盘指纹比对，
  // 即可发现"磁盘已更新但 SW 未重启"的同版本号内容漂移——版本号比对发现不了这种情况。
  // 缺失表示 SW 旧到没有该功能；HASH_UNAVAILABLE 表示上报过但计算失败，两者语义不同。
  reportedCodeHash(): string | null { return this.#extensionCodeHash; }

  // 要求扩展硬重载（绕过其内部的忙碌/重载守卫）：桌面端检测到运行版本落后于
  // 磁盘文件、且常规 reload 通道一直没生效时启用
  setReloadHint(active: boolean): void { this.#reloadHint = active; }

  // 本地 API（/v1/local）：供本机 MCP server 等受信进程复用命令管道；由桌面端注册具体语义
  setLocalHandler(handler: (type: string, payload: unknown) => Promise<unknown>): void { this.#localHandler = handler; }

  // 密钥变化（启动加载/自动配对/清除配对）时回调，桌面端据此维护 MCP 端点描述文件
  onSecretChange(callback: (secret: string | null) => void): void { this.#onSecretChange = callback; }

  secretText(): string | null { return this.#secret?.toString("base64url") ?? null; }

  async start(): Promise<void> {
    if (this.#server) return;
    try { this.#secret = Buffer.from((await readFile(this.#secretFile, "utf8")).trim(), "base64url"); } catch { this.#secret = null; }
    this.#onSecretChange?.(this.secretText());
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#port, BRIDGE_HOST, () => { this.#server!.off("error", reject); this.#boundPort = (this.#server!.address() as { port: number }).port; resolve(); });
    });
  }

  // 实际监听端口：测试传 port 0 时由操作系统分配临时端口，
  // 彻底避免随机段端口与其它测试进程/正在运行的应用冲突导致的偶发失败
  port(): number {
    if (this.#boundPort === null) throw new Error("bridge server is not listening");
    return this.#boundPort;
  }

  async close(): Promise<void> {
    for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(new Error("Bridge closed")); }
    this.#pending.clear();
    this.#commands = [];
    this.#boundPort = null;
    const server = this.#server; this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  state(now = Date.now()): PairingState {
    return { paired: Boolean(this.#secret), connected: now - this.#lastSeen < 15_000, extensionVersion: this.#extensionVersion };
  }

  async clearPairing(): Promise<void> { this.#secret = null; await rm(this.#secretFile, { force: true }); this.#onSecretChange?.(null); }

  request(type: BridgeCommandType, payload: unknown, timeoutMs = 60_000): Promise<BridgeResult> {
    const requestId = randomBytes(16).toString("hex");
    const createdAt = Date.now();
    const command: BridgeCommand = { protocolVersion: 1, requestId, type, createdAt, expiresAt: createdAt + timeoutMs, payload };
    this.#commands.push(command);
    return new Promise((resolve, reject) => {
      // 活性窗口模型：超时不再是一锤子买卖。命令被扩展接管执行期间，扩展定期 POST /v1/progress
      // 报心跳，每次心跳把窗口重置为完整预算——只要命令在推进就继续等；命令死亡（心跳停止）后
      // 窗口才会到期。旧扩展不发心跳，行为退化为固定预算超时，向后兼容。
      const expire = (): void => { this.#pending.delete(requestId); this.#commands = this.#commands.filter((item) => item.requestId !== requestId); reject(new Error("Browser bridge request timed out")); };
      const timer = setTimeout(expire, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer, timeoutMs });
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (this.#expectedExtensionVersion) {
        res.setHeader("X-Expected-Extension-Version", this.#expectedExtensionVersion);
        res.setHeader("Access-Control-Expose-Headers", "X-Expected-Extension-Version");
      }
      // 硬重载提示：扩展轮询到该头后立即 chrome.runtime.reload()，绕过其内部守卫
      if (this.#reloadHint) res.setHeader("X-Reload-Extension", "1");
      if (req.method === "GET" && req.url === "/v1/health") { const state = this.state(); return json(res, 200, { protocolVersion: 1, paired: state.paired, connected: state.connected }); }
      if (req.method === "POST" && req.url === "/v1/pair/auto") { if (!isExtensionOrigin(req.headers.origin)) return json(res, 403, { error: "invalid_origin" }); return await this.#pairAutomatically(res); }
      // 本地 API：与扩展共用密钥但独立分支，不参与扩展在线状态（lastSeen）统计
      if (req.method === "POST" && req.url === "/v1/local") {
        if (!this.#authorize(req)) return json(res, 401, { error: "unauthorized" });
        if (!this.#localHandler) return json(res, 503, { error: "local_api_unavailable" });
        const body = await readJson<{ type?: unknown; payload?: unknown }>(req);
        if (typeof body.type !== "string" || body.type.length === 0 || body.type.length > 64) return json(res, 400, { error: "invalid_type" });
        const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
        try { return json(res, 200, { ok: true, result: await this.#localHandler(body.type, payload) }); }
        catch (error) { return json(res, 200, { ok: false, error: error instanceof Error ? error.message : "local_command_failed" });
        }
      }
      if (!this.#authorize(req)) return json(res, 401, { error: "unauthorized" });
      this.#lastSeen = Date.now();
      const reported = req.headers["x-extension-version"];
      if (typeof reported === "string" && /^[0-9.]{1,20}$/.test(reported)) this.#extensionVersion = reported;
      const reportedHash = req.headers["x-extension-code-hash"];
      if (typeof reportedHash === "string" && /^[A-Za-z0-9_-]{11,128}$/.test(reportedHash)) this.#extensionCodeHash = reportedHash;
      if (req.method === "GET" && (req.url === "/v1/commands" || req.url?.startsWith("/v1/commands?"))) {
        const waitSeconds = Number(new URLSearchParams(req.url?.split("?")[1] ?? "").get("wait") ?? 0);
        if (!this.#commands.length && Number.isFinite(waitSeconds) && waitSeconds > 0) {
          const deadline = Date.now() + Math.min(waitSeconds, 10) * 1000;
          while (!this.#commands.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return json(res, 200, this.#commands.splice(0, 20));
      }
      if (req.method === "POST" && req.url === "/v1/progress") {
        // 命令活性心跳：扩展在执行期间定期上报，桌面端把该命令的超时窗口重置为完整预算。
        // 慢同步（完整校准、项目多）不再被固定预算误杀；命令真卡死时心跳停止，窗口到期兜底。
        const body = await readJson<{ protocolVersion?: unknown; requestId?: unknown }>(req);
        if (body.protocolVersion !== 1 || typeof body.requestId !== "string") return json(res, 400, { error: "invalid_progress" });
        // 提取局部 const：对象属性的类型收窄不会进入 setTimeout 闭包，直接引用 body.requestId 会报 TS2345
        const requestId = body.requestId;
        const pending = this.#pending.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => { this.#pending.delete(requestId); this.#commands = this.#commands.filter((item) => item.requestId !== requestId); pending.reject(new Error("Browser bridge request timed out")); }, pending.timeoutMs);
        }
        return json(res, 204, null);
      }
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

  async #pairAutomatically(res: ServerResponse): Promise<void> {
    if (this.#secret) return json(res, 409, { error: "already_paired" });
    this.#secret = randomBytes(32);
    await mkdir(dirname(this.#secretFile), { recursive: true });
    await writeFile(this.#secretFile, this.#secret.toString("base64url"), { encoding: "utf8", mode: 0o600 });
    this.#onSecretChange?.(this.secretText());
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
export const FULL_CALIBRATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
export function chooseCacheSyncMode(snapshot: { fullSyncedAt: number | null } | null, forceFull: boolean, now = Date.now()): "full" | "incremental" {
  return forceFull || !snapshot?.fullSyncedAt || now - snapshot.fullSyncedAt >= FULL_CALIBRATION_INTERVAL_MS ? "full" : "incremental";
}
interface CacheFile { schemaVersion: 1; accounts: Record<string, { label: string; mutations?: Record<string, { action: "archive" | "restore" | "delete"; at: number }>; projects?: Record<string, string>; states: Partial<Record<CachedConversation["state"], { syncedAt: number; fullSyncedAt: number | null; records: CachedConversation[] }>> }> }

export class ConversationIndexStore {
  readonly #file: string;
  #data: CacheFile = { schemaVersion: 1, accounts: {} };
  constructor(file: string) { this.#file = file; }
  async load(): Promise<void> { try { const value = JSON.parse(await readFile(this.#file, "utf8")) as CacheFile; this.#data = value.schemaVersion === 1 && value.accounts && typeof value.accounts === "object" ? value : { schemaVersion: 1, accounts: {} }; } catch { this.#data = { schemaVersion: 1, accounts: {} }; } }
  accounts(): Array<{ key: string; label: string }> { return Object.entries(this.#data.accounts).map(([key, value]) => ({ key, label: value.label })); }
  stats(): { accounts: number; records: number; bytes: number; lastSyncedAt: number | null; lastFullSyncedAt: number | null } { const states = Object.values(this.#data.accounts).flatMap((account) => Object.values(account.states).filter((state): state is NonNullable<typeof state> => Boolean(state))); return { accounts: Object.keys(this.#data.accounts).length, records: states.reduce((sum, state) => sum + state.records.length, 0), bytes: Buffer.byteLength(JSON.stringify(this.#data)), lastSyncedAt: states.reduce<number | null>((latest, state) => latest === null || state.syncedAt > latest ? state.syncedAt : latest, null), lastFullSyncedAt: states.reduce<number | null>((latest, state) => state.fullSyncedAt !== null && (latest === null || state.fullSyncedAt > latest) ? state.fullSyncedAt : latest, null) }; }
  read(accountKey: string, state: CachedConversation["state"]): { syncedAt: number; fullSyncedAt: number | null; records: CachedConversation[]; projects: Record<string, string> } | null { const account = this.#data.accounts[accountKey]; const value = account?.states[state]; return value ? { ...structuredClone(value), projects: { ...(account.projects ?? {}) } } : null; }
  async replace(accountKey: string, label: string, state: CachedConversation["state"], records: CachedConversation[], full: boolean, projects?: Record<string, string>): Promise<void> {
    const account = this.#data.accounts[accountKey] ??= { label, states: {} }; account.label = label;
    if (projects && Object.keys(projects).length) account.projects = projects;
    const now = Date.now(); const mutations = account.mutations ??= {}; for (const [id, mutation] of Object.entries(mutations)) if (now - mutation.at > 600_000) delete mutations[id];
    const filtered = records.filter((record) => { const mutation = mutations[record.id]; if (!mutation) return true; if (mutation.action === "delete") return false; const expected = mutation.action === "archive" ? "archived" : "active"; if (record.state === expected) { delete mutations[record.id]; return true; } return false; });
    account.states[state] = { syncedAt: now, fullSyncedAt: full ? now : account.states[state]?.fullSyncedAt ?? null, records: dedupe(filtered) }; await this.#save();
  }
  async merge(accountKey: string, label: string, state: CachedConversation["state"], records: CachedConversation[], projects?: Record<string, string>): Promise<void> {
    const old = this.read(accountKey, state)?.records ?? [];
    const previous = new Map(old.map((record) => [record.id, record]));
    const filled = records.map((record) => { const prior = previous.get(record.id); return !record.projectId && prior?.projectId ? { ...record, projectId: prior.projectId } : record; });
    await this.replace(accountKey, label, state, dedupe([...old, ...filled]), false, projects);
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

  async applyProjectMove(accountKey: string, succeeded: string[], projectId: string | null): Promise<void> {
    const account = this.#data.accounts[accountKey]; if (!account) return;
    const ids = new Set(succeeded);
    for (const state of Object.values(account.states)) {
      if (!state) continue;
      state.records = state.records.map((record) => {
        if (!ids.has(record.id)) return record;
        const next = { ...record };
        if (projectId) next.projectId = projectId; else delete next.projectId;
        return next;
      });
    }
    await this.#save();
  }
  async clear(): Promise<void> { this.#data = { schemaVersion: 1, accounts: {} }; await this.#save(); }
  async #save(): Promise<void> { await mkdir(dirname(this.#file), { recursive: true }); const temp = `${this.#file}.tmp`; await writeFile(temp, `${JSON.stringify(this.#data)}\n`, "utf8"); await rename(temp, this.#file); }
}
// Map 按 id 去重与 conversation-domain#dedupeById 同源；此处附带按 updatedAt 倒序的存储不变量，
// 且本包刻意保持零运行时依赖，故未直接引用共享实现。
function dedupe(records: CachedConversation[]): CachedConversation[] { return [...new Map(records.map((item) => [item.id, item])).values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)); }
export function accountKey(rawId: string): string { return createHash("sha256").update(rawId).digest("hex"); }
