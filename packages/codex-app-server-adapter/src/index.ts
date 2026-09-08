import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexThread {
  id: string;
  preview: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  projectId: string | null;
  parentThreadId: string | null;
  status: { type: string; activeFlags?: unknown[] };
  turns?: CodexTurn[];
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  status: unknown;
  items: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
}

type SpawnProcess = (command: string, args: string[]) => ChildProcessWithoutNullStreams;
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> };

export class CodexAppServer {
  readonly #command: string;
  readonly #spawn: SpawnProcess;
  #process: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #starting: Promise<void> | null = null;
  #ready = false;

  constructor(command = "codex", spawnProcess: SpawnProcess = (name, args) => spawn(name, args)) {
    this.#command = command;
    this.#spawn = spawnProcess;
  }

  async start(): Promise<void> {
    if (this.#ready) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#startProcess();
    try {
      await this.#starting;
    } catch (error) {
      this.#process?.kill();
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.#starting = null;
    }
  }

  async #startProcess(): Promise<void> {
    const child = this.#spawn(this.#command, ["app-server", "--stdio"]);
    this.#process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));
    child.stderr.resume();
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code) => this.#failAll(new Error(`Codex App Server exited (${code ?? "unknown"})`)));

    await this.#requestRaw("initialize", {
      clientInfo: { name: "conversation-manager", title: "Conversation Manager", version: "0.4.0" },
      capabilities: null
    });
    this.#send({ method: "initialized" });
    this.#ready = true;
  }

  async list(params: { cursor?: string | null; limit?: number; archived?: boolean; searchTerm?: string | null; full?: boolean; includeDerived?: boolean } = {}): Promise<ThreadListResponse> {
    return this.request("thread/list", {
      cursor: params.cursor ?? null,
      limit: params.limit ?? 100,
      archived: params.archived ?? false,
      searchTerm: params.searchTerm ?? null,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: params.includeDerived
        ? ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"]
        : ["cli", "vscode", "appServer"],
      useStateDbOnly: !params.full
    });
  }

  async archive(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async readThread(threadId: string): Promise<unknown> {
    const result = await this.request<unknown>("thread/read", { threadId });
    return result;
  }

  async unarchive(threadId: string): Promise<{ thread: CodexThread }> {
    return this.request("thread/unarchive", { threadId });
  }

  async delete(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }

  async previewDelete(ids: string[]): Promise<{ records: CodexThread[]; missing: string[]; running: string[]; fingerprint: string }> {
    const records: CodexThread[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = await this.list({ archived, cursor, includeDerived: true });
        records.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
    }
    const unique = [...new Map(records.map((record) => [record.id, record])).values()];
    const requested = new Set(ids);
    const affected = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of unique) {
        if (record.parentThreadId && affected.has(record.parentThreadId) && !affected.has(record.id)) {
          affected.add(record.id);
          changed = true;
        }
      }
    }
    const selected = unique.filter((record) => affected.has(record.id));
    const found = new Set(unique.map((record) => record.id));
    const missing = [...requested].filter((id) => !found.has(id));
    const running = selected.filter((record) => record.status?.type === "active").map((record) => record.id);
    const fingerprint = selected
      .map((record) => `${record.id}:${record.updatedAt}:${record.status?.type ?? "unknown"}`)
      .sort()
      .join("|");
    return { records: selected, missing, running, fingerprint };
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.start();
    return this.#requestRaw(method, params);
  }

  #requestRaw<T>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      try {
        this.#send(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.#process?.kill();
    this.#failAll(new Error("Codex App Server closed"));
  }

  #send(message: object): void {
    if (!this.#process?.stdin.writable) throw new Error("Codex App Server is not available");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    if (!line.trim()) return;
    let message: { id?: number | string; method?: string; result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      this.#send({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error.message ?? `Codex request failed (${message.error.code ?? "unknown"})`));
    else pending.resolve(message.result);
  }

  #failAll(error: Error): void {
    this.#process = null;
    this.#ready = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
