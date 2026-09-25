import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

/** Codex 真实 Token 用量统计：扫描本机 ~/.codex/sessions（含 archived_sessions）下的
 * rollout-*.jsonl 会话日志，按 token_count 事件的每次请求增量（last_token_usage）
 * 汇总输入/缓存输入/输出 Tokens、请求数与估算费用。只读计数，不读会话正文内容。
 *
 * 与官方配额无关：Codex 订阅额度不在本统计范围内，这里反映的是会话日志里
 * 每次模型请求真实发生的 Token 消耗。 */

export interface UsageCell { requests: number; input: number; cachedInput: number; output: number; costUsd: number }
export interface UsageTotals extends UsageCell { totalTokens: number }
export interface CodexUsageDay { date: string; instances: Record<string, Record<string, UsageCell>> }
export interface CodexUsageModelRow extends UsageTotals { model: string }
export interface CodexUsageInstanceRow extends UsageTotals { cwd: string }
export interface CodexUsageSummary {
  generatedAt: number;
  scannedFiles: number;
  sessions: number;
  forkedSessions: number;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  days: CodexUsageDay[];
  models: CodexUsageModelRow[];
  instances: CodexUsageInstanceRow[];
}

/** 单文件的解析产物，也是增量缓存的持久化单元（days 矩阵：日期 → 模型 → [请求, 输入, 缓存输入, 输出]）。
 * rolloutId = session_meta.payload.id（与文件名一致的本次 rollout id，通常即 App Server 的线程 id）；
 * sessionId = payload.session_id（会话链 id，resume 后的新文件沿用旧 id，fork 则指向父会话）。 */
export interface FileUsage {
  mtimeMs: number;
  size: number;
  rolloutId: string;
  sessionId: string;
  cwd: string;
  forked: boolean;
  days: Record<string, Record<string, [number, number, number, number]>>;
}

interface UsageCache { schemaVersion: typeof CACHE_SCHEMA_VERSION; files: Record<string, FileUsage> }

const CACHE_SCHEMA_VERSION = 2;
const MAX_LINES_PER_FILE = 400_000;

/** 本地时区的 YYYY-MM-DD（与渲染端 stats-model#dateKey 一致，按日历日聚合） */
export function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function eventDateKey(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? localDateKey(ms) : null;
}

// ---- 费用估算：按公开 API 价格（USD / 百万 Tokens）。取第一个命中的模式；
// 未命中走兜底价。只是参考值，订阅额度内实际并不按 Token 计费。 ----
export interface ModelPrice { input: number; cachedInput: number; output: number }
const PRICING: Array<[RegExp, ModelPrice]> = [
  [/^gpt-4(o|\.1)/i, { input: 2.5, cachedInput: 1.25, output: 10 }],
  [/^o3-min/i, { input: 1.1, cachedInput: 0.275, output: 4.4 }],
  [/^o4-min/i, { input: 1.1, cachedInput: 0.275, output: 4.4 }],
  [/^o[134]/i, { input: 2, cachedInput: 0.5, output: 8 }]
];
export const FALLBACK_PRICE: ModelPrice = { input: 1.25, cachedInput: 0.125, output: 10 };

export function modelPrice(model: string): ModelPrice {
  for (const [pattern, price] of PRICING) if (pattern.test(model)) return price;
  return FALLBACK_PRICE;
}

/** 输入 Tokens 为计费全量，其中缓存命中部分按缓存价计；合计 = 输入 + 输出（缓存是输入的子集） */
export function estimateCost(model: string, cell: { input: number; cachedInput: number; output: number }): number {
  const price = modelPrice(model);
  const uncached = Math.max(0, cell.input - cell.cachedInput);
  return (uncached * price.input + cell.cachedInput * price.cachedInput + cell.output * price.output) / 1_000_000;
}

// ---- 单文件 JSONL 解析 ----

interface TokenUsageFields { input: number; cachedInput: number; output: number }

function usageFields(raw: unknown): TokenUsageFields | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const num = (key: string): number => typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0 ? row[key] : 0;
  if (typeof row.input_tokens !== "number" && typeof row.output_tokens !== "number") return null;
  return { input: num("input_tokens"), cachedInput: num("cached_input_tokens"), output: num("output_tokens") };
}

function forkFlag(meta: Record<string, unknown>): boolean {
  if (typeof meta.forked_from_id === "string" && meta.forked_from_id) return true;
  if (meta.source && typeof meta.source === "object" && "subagent" in (meta.source as Record<string, unknown>)) return true;
  return meta.thread_source === "subagent";
}

const EMPTY_CELL = (): [number, number, number, number] => [0, 0, 0, 0];

/** 逐行解析一个 rollout JSONL。增量取 last_token_usage；缺失时按累计值差值推导。
 * total 未相对上一条增长的 token_count 事件视为同一请求的重复上报，跳过——
 * 同一请求在日志里常连发两条（完成 + 限流快照）。 */
export async function parseSessionFile(file: string): Promise<Omit<FileUsage, "mtimeMs" | "size">> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  const result: Omit<FileUsage, "mtimeMs" | "size"> = { rolloutId: "", sessionId: "", cwd: "", forked: false, days: {} };
  let model = "";
  let previousTotal: TokenUsageFields | null = null;
  let lineCount = 0;
  try {
    for await (const line of lines) {
      if (lineCount++ > MAX_LINES_PER_FILE) break;
      if (!line || line.length > 4_000_000) continue;
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== "object") continue;
      const row = event as Record<string, unknown>;
      const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : null;
      if (!payload) continue;
      if (row.type === "session_meta") {
        result.rolloutId = typeof payload.id === "string" ? payload.id : "";
        result.sessionId = typeof payload.session_id === "string" ? payload.session_id : result.rolloutId;
        result.cwd = typeof payload.cwd === "string" ? payload.cwd : "";
        result.forked = forkFlag(payload);
        continue;
      }
      if (row.type === "turn_context") {
        if (typeof payload.model === "string" && payload.model) model = payload.model;
        continue;
      }
      if (row.type !== "event_msg" || payload.type !== "token_count") continue;
      const info = payload.info && typeof payload.info === "object" ? payload.info as Record<string, unknown> : null;
      if (!info) continue;
      const total = usageFields(info.total_token_usage);
      if (!total) continue;
      // total 与上一条完全相同 ⇒ 同一请求被重复上报，跳过
      if (previousTotal && total.input === previousTotal.input && total.cachedInput === previousTotal.cachedInput && total.output === previousTotal.output) continue;
      // 增量优先用 last；缺失时按累计差值推导（直接用 total 会把之前的量重复计入）
      const last = usageFields(info.last_token_usage) ?? {
        input: Math.max(0, total.input - (previousTotal?.input ?? 0)),
        cachedInput: Math.max(0, total.cachedInput - (previousTotal?.cachedInput ?? 0)),
        output: Math.max(0, total.output - (previousTotal?.output ?? 0))
      };
      previousTotal = total;
      if (last.input + last.output === 0) continue;
      const date = eventDateKey(typeof row.timestamp === "string" ? row.timestamp : "");
      if (!date) continue;
      const perModel = result.days[date] ??= {};
      const cell = perModel[model] ??= EMPTY_CELL();
      cell[0] += 1;
      cell[1] += last.input;
      cell[2] += last.cachedInput;
      cell[3] += last.output;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return result;
}

// ---- 聚合 ----

const emptyCell = (): UsageCell => ({ requests: 0, input: 0, cachedInput: 0, output: 0, costUsd: 0 });

function accumulate(target: UsageCell, values: { requests: number; input: number; cachedInput: number; output: number; costUsd: number }): void {
  target.requests += values.requests;
  target.input += values.input;
  target.cachedInput += values.cachedInput;
  target.output += values.output;
  target.costUsd += values.costUsd;
}

function finishTotals(cell: UsageCell): UsageTotals {
  return { ...cell, totalTokens: cell.input + cell.output };
}

/** 把全部文件的用量矩阵聚合成摘要：days 按日期升序，models / instances 按合计降序。
 * 费用按"日期 × 实例 × 模型"粒度就地计算，渲染端任意范围筛选都能直接求和。 */
export function summarizeUsage(files: Record<string, FileUsage>, generatedAt = Date.now()): CodexUsageSummary {
  const dayInstances = new Map<string, Map<string, Map<string, UsageCell>>>();
  const modelCells = new Map<string, UsageCell>();
  const instanceCells = new Map<string, UsageCell>();
  const totals = emptyCell();
  const sessionIds = new Set<string>();
  let forkedSessions = 0;
  for (const file of Object.values(files)) {
    if (file.sessionId) sessionIds.add(file.sessionId);
    if (file.forked) forkedSessions += 1;
    const instance = file.cwd || "";
    for (const [date, models] of Object.entries(file.days)) {
      const perInstance = dayInstances.get(date) ?? new Map<string, Map<string, UsageCell>>();
      for (const [model, values] of Object.entries(models)) {
        const base = { requests: values[0], input: values[1], cachedInput: values[2], output: values[3], costUsd: estimateCost(model, { input: values[1], cachedInput: values[2], output: values[3] }) };
        const dayCell = perInstance.get(instance)?.get(model) ?? emptyCell();
        accumulate(dayCell, base);
        let perModel = perInstance.get(instance);
        if (!perModel) { perModel = new Map(); perInstance.set(instance, perModel); }
        perModel.set(model, dayCell);
        dayInstances.set(date, perInstance);
        let modelCell = modelCells.get(model);
        if (!modelCell) { modelCell = emptyCell(); modelCells.set(model, modelCell); }
        accumulate(modelCell, base);
        const instanceCell = instanceCells.get(instance) ?? emptyCell();
        instanceCells.set(instance, instanceCell);
        accumulate(instanceCell, base);
        accumulate(totals, base);
      }
    }
  }
  const days: CodexUsageDay[] = [...dayInstances.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, perInstance]) => ({
    date,
    instances: Object.fromEntries([...perInstance.entries()].map(([key, cells]) => [key, Object.fromEntries(cells)]))
  }));
  const models = [...modelCells.entries()].map(([model, cell]) => ({ model, ...finishTotals(cell) })).sort((a, b) => b.totalTokens - a.totalTokens);
  const instances = [...instanceCells.entries()].map(([cwd, cell]) => ({ cwd, ...finishTotals(cell) })).sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    generatedAt,
    scannedFiles: Object.keys(files).length,
    sessions: sessionIds.size,
    forkedSessions,
    requests: totals.requests,
    inputTokens: totals.input,
    cachedInputTokens: totals.cachedInput,
    outputTokens: totals.output,
    totalTokens: totals.input + totals.output,
    costUsd: totals.costUsd,
    days,
    models,
    instances
  };
}

// ---- 增量扫描：mtime/size 未变的文件直接复用缓存，避免每次全量重读 ----

function cellFromCache(values: unknown): [number, number, number, number] | null {
  if (!Array.isArray(values) || values.length !== 4) return null;
  return values.map((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : Number.NaN) as [number, number, number, number];
}

function sanitizeFileUsage(raw: unknown): FileUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.mtimeMs !== "number" || typeof row.size !== "number") return null;
  const days: FileUsage["days"] = {};
  if (row.days && typeof row.days === "object") {
    for (const [date, models] of Object.entries(row.days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !models || typeof models !== "object") continue;
      for (const [model, values] of Object.entries(models as Record<string, unknown>)) {
        const cell = cellFromCache(values);
        if (!cell || cell.some((value) => !Number.isFinite(value))) continue;
        (days[date] ??= {})[model.slice(0, 120)] = cell;
      }
    }
  }
  return {
    mtimeMs: row.mtimeMs,
    size: row.size,
    rolloutId: typeof row.rolloutId === "string" ? row.rolloutId.slice(0, 128) : typeof row.sessionId === "string" ? row.sessionId.slice(0, 128) : "",
    sessionId: typeof row.sessionId === "string" ? row.sessionId.slice(0, 128) : "",
    cwd: typeof row.cwd === "string" ? row.cwd.slice(0, 500) : "",
    forked: row.forked === true,
    days
  };
}

async function loadCache(file: string): Promise<UsageCache> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    if (row.schemaVersion !== CACHE_SCHEMA_VERSION || !row.files || typeof row.files !== "object") return { schemaVersion: CACHE_SCHEMA_VERSION, files: {} };
    const files: Record<string, FileUsage> = {};
    for (const [path, raw] of Object.entries(row.files as Record<string, unknown>)) {
      const usage = sanitizeFileUsage(raw);
      if (usage) files[path] = usage;
    }
    return { schemaVersion: CACHE_SCHEMA_VERSION, files };
  } catch { return { schemaVersion: CACHE_SCHEMA_VERSION, files: {} }; }
}

async function saveCache(file: string, cache: UsageCache): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(cache)}\n`, "utf8");
  await rename(temp, file);
}

async function listSessionFiles(codexHome: string): Promise<string[]> {
  const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
  const files: string[] = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
      }
    }
  }
  return files;
}

async function parseWithLimit(paths: string[], limit: number, run: (path: string) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, paths.length) }, async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      if (path === undefined) break;
      await run(path);
    }
  });
  await Promise.all(workers);
}

export interface ScanResult { summary: CodexUsageSummary; files: Record<string, FileUsage>; cacheWritten: boolean }

/** 全量增量扫描：枚举 ~/.codex 下两个会话目录的所有 JSONL，未变更文件走缓存。
 * 单个文件解析失败不影响整体（当次跳过，下次 mtime 变化时重试）。
 * 返回 files（相对路径 → 单文件用量），供线程级索引复用。 */
export async function scanCodexUsage(codexHome: string, cacheFile: string | null, options: { force?: boolean } = {}): Promise<ScanResult> {
  const cache: UsageCache = options.force ? { schemaVersion: CACHE_SCHEMA_VERSION, files: {} } : await loadCache(cacheFile ?? join(codexHome, "usage-cache.json"));
  const paths = await listSessionFiles(codexHome);
  const nextFiles: Record<string, FileUsage> = {};
  const toParse: string[] = [];
  await parseWithLimit(paths, 32, async (path) => {
    let info;
    try { info = await stat(path); } catch { return; }
    const key = relative(codexHome, path).split(sep).join("/");
    const cached = cache.files[key];
    if (cached && cached.mtimeMs === Math.floor(info.mtimeMs * 1000) / 1000 && cached.size === info.size) {
      nextFiles[key] = cached;
      return;
    }
    toParse.push(path);
    nextFiles[key] = { mtimeMs: Math.floor(info.mtimeMs * 1000) / 1000, size: info.size, rolloutId: "", sessionId: "", cwd: "", forked: false, days: {} };
  });
  await parseWithLimit(toParse, 6, async (path) => {
    try {
      const parsed = await parseSessionFile(path);
      const key = relative(codexHome, path).split(sep).join("/");
      nextFiles[key] = { ...nextFiles[key]!, ...parsed };
    } catch { delete nextFiles[relative(codexHome, path).split(sep).join("/")]; }
  });
  const summary = summarizeUsage(nextFiles);
  let cacheWritten = false;
  if (cacheFile && toParse.length + Object.keys(cache.files).length > 0) {
    try { await saveCache(cacheFile, { schemaVersion: CACHE_SCHEMA_VERSION, files: nextFiles }); cacheWritten = true; } catch {}
  }
  return { summary, files: nextFiles, cacheWritten };
}

export function emptyUsageSummary(): CodexUsageSummary {
  return summarizeUsage({});
}

// ---- 线程级索引：Codex 任务列表的会话 ID → rollout 文件与单文件用量 ----

export interface ThreadUsageDetail {
  file: string;
  input: number;
  cachedInput: number;
  output: number;
  totalTokens: number;
  requests: number;
  costUsd: number;
  cwd: string;
  updatedAt: number;
}

function sumFileUsage(usage: FileUsage): Omit<ThreadUsageDetail, "file" | "cwd" | "updatedAt"> {
  const totals = { requests: 0, input: 0, cachedInput: 0, output: 0, costUsd: 0 };
  for (const models of Object.values(usage.days)) {
    for (const [model, values] of Object.entries(models)) {
      totals.requests += values[0];
      totals.input += values[1];
      totals.cachedInput += values[2];
      totals.output += values[3];
      totals.costUsd += estimateCost(model, { input: values[1], cachedInput: values[2], output: values[3] });
    }
  }
  return { ...totals, totalTokens: totals.input + totals.output };
}

/** 线程 id → 最近一次 rollout 文件的绝对路径与该文件的用量。
 * rolloutId（payload.id，通常就是 App Server 线程 id）与 sessionId（会话链 id）都建立索引：
 * resume 链按会话 id 命中最新文件；fork 的 rolloutId 优先于其父会话 id，保证指向 fork 自己的文件。 */
export function buildThreadUsageIndex(files: Record<string, FileUsage>, codexHome: string): Map<string, ThreadUsageDetail> {
  const index = new Map<string, ThreadUsageDetail>();
  const put = (id: string, detail: ThreadUsageDetail): void => {
    const current = index.get(id);
    if (!current || current.updatedAt < detail.updatedAt) index.set(id, detail);
  };
  const chainLatest = new Map<string, ThreadUsageDetail>();
  for (const [path, usage] of Object.entries(files)) {
    if (!usage.rolloutId && !usage.sessionId) continue;
    const detail: ThreadUsageDetail = {
      file: join(codexHome, ...path.split("/")),
      cwd: usage.cwd,
      updatedAt: Math.round(usage.mtimeMs),
      ...sumFileUsage(usage)
    };
    if (usage.rolloutId) put(usage.rolloutId, detail);
    if (usage.sessionId && usage.sessionId !== usage.rolloutId) {
      const latest = chainLatest.get(usage.sessionId);
      if (!latest || latest.updatedAt < detail.updatedAt) chainLatest.set(usage.sessionId, detail);
    }
  }
  for (const [id, detail] of chainLatest) if (!index.has(id)) index.set(id, detail);
  return index;
}
