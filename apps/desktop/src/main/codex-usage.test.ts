import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildThreadUsageIndex, buildUsageReportCsv, buildUsageReportMarkdown, estimateCost, localDateKey, modelPrice, parseSessionFile, sanitizeUsagePreferences, scanCodexUsage, setCustomPricing, summarizeUsage, topUsageSessions, usageBudgetStatus, type CodexUsageSummary, type FileUsage } from "./codex-usage.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-usage-"));
  tempDirs.push(dir);
  return dir;
}

const tokenLine = (timestamp: string, last: { input: number; cached: number; output: number }, total?: unknown) => JSON.stringify({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: total ?? { input_tokens: last.input, cached_input_tokens: last.cached, output_tokens: last.output },
      last_token_usage: { input_tokens: last.input, cached_input_tokens: last.cached, output_tokens: last.output }
    }
  }
});

const metaLine = (cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  timestamp: "2026-09-20T08:00:00.000Z",
  type: "session_meta",
  payload: { id: "session-a", cwd, ...extra }
});
const contextLine = (model: string) => JSON.stringify({
  timestamp: "2026-09-20T08:00:01.000Z",
  type: "turn_context",
  payload: { model }
});

async function writeSessions(home: string, files: Record<string, string[]>): Promise<void> {
  for (const [name, lines] of Object.entries(files)) {
    const file = join(home, name);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  }
}

describe("localDateKey", () => {
  it("formats a local calendar date", () => {
    const ms = new Date(2026, 8, 25, 13, 30).getTime();
    expect(localDateKey(ms)).toBe("2026-09-25");
  });
});

describe("estimateCost", () => {
  it("bills cached input at the cached rate and the rest at the input rate", () => {
    const cost = estimateCost("gpt-5.3-codex", { input: 2_000_000, cachedInput: 1_000_000, output: 100_000 });
    // 官方价（$/1M）：输入 1.75 · 缓存 0.175 · 输出 14
    // (2M-1M)*1.75 + 1M*0.175 + 0.1M*14 = 1.75 + 0.175 + 1.4
    expect(cost).toBeCloseTo(3.325, 6);
  });
  it("uses official published prices for known models", () => {
    expect(modelPrice("gpt-6-luna")).toEqual({ input: 0.1, cachedInput: 0.01, output: 0.5 });
    expect(modelPrice("gpt-5.6-sol")).toEqual({ input: 4, cachedInput: 0.4, output: 20 });
    expect(modelPrice("gpt-5.3-codex")).toEqual({ input: 1.75, cachedInput: 0.175, output: 14 });
    expect(modelPrice("gpt-5.4")).toEqual({ input: 2.5, cachedInput: 0.25, output: 15 });
  });
  it("falls back to the default price for unknown models", () => {
    expect(modelPrice("totally-unknown-model")).toEqual(modelPrice("anything-else"));
  });
});

describe("parseSessionFile", () => {
  it("aggregates per-request deltas, dedupes repeated reports and attributes models", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "rollout-1.jsonl");
    await writeFile(file, [
      metaLine("E:\\work\\demo"),
      contextLine("gpt-5.3-codex"),
      tokenLine("2026-09-20T08:01:00.000Z", { input: 100, cached: 60, output: 10 }),
      // 同一请求的重复上报（total 与 last 完全一致）应被跳过
      tokenLine("2026-09-20T08:01:02.000Z", { input: 100, cached: 60, output: 10 }),
      // info 为 null 的中间态应被跳过
      JSON.stringify({ timestamp: "2026-09-20T08:01:03.000Z", type: "event_msg", payload: { type: "token_count", info: null } }),
      tokenLine("2026-09-20T08:02:00.000Z", { input: 200, cached: 120, output: 20 }, { input_tokens: 300, cached_input_tokens: 180, output_tokens: 30 }),
      // 第二个回合换模型
      contextLine("gpt-6-luna"),
      tokenLine("2026-09-21T09:00:00.000Z", { input: 50, cached: 0, output: 5 }, { input_tokens: 350, cached_input_tokens: 180, output_tokens: 35 }),
      // 非法行静默忽略
      "not-json",
      JSON.stringify({ timestamp: "2026-09-21T09:00:05.000Z", type: "response_item", payload: { type: "message" } })
    ].join("\n"), "utf8");
    const parsed = await parseSessionFile(file);
    expect(parsed.rolloutId).toBe("session-a");
    expect(parsed.sessionId).toBe("session-a");
    expect(parsed.cwd).toBe("E:\\work\\demo");
    expect(parsed.forked).toBe(false);
    expect(parsed.days["2026-09-20"]!["gpt-5.3-codex"]).toEqual([2, 300, 180, 30]);
    expect(parsed.days["2026-09-21"]!["gpt-6-luna"]).toEqual([1, 50, 0, 5]);
  });

  it("captures rollout id and session id separately for resumed sessions", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "rollout-resumed.jsonl");
    await writeFile(file, [
      JSON.stringify({ timestamp: "2026-09-20T08:00:00.000Z", type: "session_meta", payload: { id: "rollout-b", session_id: "session-a", cwd: "E:\\work" } }),
      tokenLine("2026-09-20T08:01:00.000Z", { input: 10, cached: 0, output: 1 })
    ].join("\n"), "utf8");
    const parsed = await parseSessionFile(file);
    expect(parsed.rolloutId).toBe("rollout-b");
    expect(parsed.sessionId).toBe("session-a");
  });

  it("derives the delta from cumulative totals when last_token_usage is missing", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "rollout-legacy.jsonl");
    await writeFile(file, [
      metaLine("E:\\work"),
      contextLine("gpt-5.3-codex"),
      // 只有 total（老版本日志）：首条增量 = total 本身
      JSON.stringify({ timestamp: "2026-09-20T08:01:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } } } }),
      // 第二条缺 last：增量 = total 差值（150, 缓存回落钳到 0, 20）
      JSON.stringify({ timestamp: "2026-09-20T08:02:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 40, output_tokens: 30 } } } }),
      // total 未增长：跳过
      JSON.stringify({ timestamp: "2026-09-20T08:03:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 40, output_tokens: 30 } } } })
    ].join("\n"), "utf8");
    const parsed = await parseSessionFile(file);
    expect(parsed.days["2026-09-20"]!["gpt-5.3-codex"]).toEqual([2, 250, 60, 30]);
  });

  it("flags forked / subagent sessions and keeps files without usage events empty", async () => {
    const dir = await makeTempDir();
    const forked = join(dir, "rollout-fork.jsonl");
    await writeFile(forked, [
      metaLine("E:\\work", { forked_from_id: "session-a", source: { subagent: { parent_thread_id: "session-a" } } }),
      tokenLine("2026-09-22T10:00:00.000Z", { input: 10, cached: 0, output: 1 })
    ].join("\n"), "utf8");
    const plain = join(dir, "rollout-plain.jsonl");
    await writeFile(plain, metaLine("E:\\work"), "utf8");
    const fork = await parseSessionFile(forked);
    expect(fork.forked).toBe(true);
    expect(fork.days["2026-09-22"]![""]).toEqual([1, 10, 0, 1]);
    expect((await parseSessionFile(plain)).days).toEqual({});
  });
});

describe("summarizeUsage", () => {
  it("merges files into sorted day/model/instance rollups with costs", () => {
    const summary = summarizeUsage({
      "a.jsonl": { mtimeMs: 1, size: 1, rolloutId: "s-a", sessionId: "s-a", cwd: "E:\\work\\demo", forked: false, days: { "2026-09-20": { "gpt-5.3-codex": [2, 300, 180, 30] } } },
      "b.jsonl": { mtimeMs: 2, size: 2, rolloutId: "s-b", sessionId: "s-a", cwd: "E:\\work\\demo", forked: true, days: { "2026-09-21": { "gpt-6-luna": [1, 50, 0, 5] }, "2026-09-19": { "gpt-6-luna": [1, 10, 0, 1] } } }
    });
    expect(summary.scannedFiles).toBe(2);
    // b.jsonl 是 a 会话链（session_id 相同）的 fork，唯一会话数为 1
    expect(summary.sessions).toBe(1);
    expect(summary.forkedSessions).toBe(1);
    expect(summary.requests).toBe(4);
    expect(summary.totalTokens).toBe(330 + 55 + 11);
    expect(summary.days.map((day) => day.date)).toEqual(["2026-09-19", "2026-09-20", "2026-09-21"]);
    const demoCell = summary.days[2]!.instances["E:\\work\\demo"]!["gpt-6-luna"]!;
    expect(demoCell.requests).toBe(1);
    expect(demoCell.input).toBe(50);
    expect(demoCell.costUsd).toBeCloseTo(estimateCost("gpt-6-luna", { input: 50, cachedInput: 0, output: 5 }), 9);
    expect(summary.models[0]!.model).toBe("gpt-5.3-codex");
    expect(summary.models[0]!.totalTokens).toBe(330);
    expect(summary.models[0]!.costUsd).toBeCloseTo(estimateCost("gpt-5.3-codex", { input: 300, cachedInput: 180, output: 30 }), 9);
    expect(summary.instances).toHaveLength(1);
    expect(summary.instances[0]!.totalTokens).toBe(396);
    expect(summary.costUsd).toBeCloseTo(summary.models.reduce((sum, row) => sum + row.costUsd, 0), 9);
  });
});

describe("buildThreadUsageIndex", () => {
  const home = "C:\\codex-home";
  const file = (rolloutId: string, sessionId: string, mtimeMs: number, requests: number): FileUsage => ({
    mtimeMs, size: 1, rolloutId, sessionId, cwd: "E:\\work", forked: rolloutId !== sessionId,
    days: requests > 0 ? { "2026-09-20": { "gpt-5.3-codex": [requests, 100, 60, 10] } } : {}
  });

  it("indexes rollout ids exactly and falls back to the newest file of the session chain", () => {
    const index = buildThreadUsageIndex({
      "sessions/a.jsonl": file("rollout-a", "rollout-a", 100, 2),
      // resume 链：新 rollout 沿用旧会话 id
      "sessions/b.jsonl": file("rollout-b", "rollout-a", 300, 5),
      // fork：自己的 rollout id，session id 指向父会话
      "sessions/c.jsonl": file("rollout-f", "rollout-a", 200, 1)
    }, home);
    expect(index.get("rollout-a")!.file).toBe(join(home, "sessions", "a.jsonl"));
    expect(index.get("rollout-b")!.requests).toBe(5);
    expect(index.get("rollout-f")!.requests).toBe(1);
    expect(index.get("rollout-f")!.cwd).toBe("E:\\work");
    // 单文件语义：totalTokens = input + output（缓存是输入子集）
    expect(index.get("rollout-b")!.totalTokens).toBe(110);
    expect(index.get("rollout-b")!.costUsd).toBeCloseTo(estimateCost("gpt-5.3-codex", { input: 100, cachedInput: 60, output: 10 }), 9);
    // 未知 id 不存在条目
    expect(index.has("missing")).toBe(false);
  });

  it("skips files without any session identifiers", () => {
    const index = buildThreadUsageIndex({ "sessions/x.jsonl": file("", "", 100, 1) }, home);
    expect(index.size).toBe(0);
  });
});

describe("scanCodexUsage", () => {
  it("scans sessions and archived_sessions, then reuses the cache for unchanged files", async () => {
    const home = await makeTempDir();
    const cacheFile = join(home, "cache", "usage-cache.json");
    await writeSessions(home, {
      "sessions/2026/09/20/rollout-a.jsonl": [
        metaLine("E:\\work\\demo"),
        contextLine("gpt-5.3-codex"),
        tokenLine("2026-09-20T08:01:00.000Z", { input: 100, cached: 60, output: 10 })
      ],
      "archived_sessions/rollout-old.jsonl": [
        metaLine("E:\\old"),
        contextLine("gpt-5.3-codex"),
        tokenLine("2026-08-01T08:01:00.000Z", { input: 40, cached: 0, output: 4 })
      ]
    });
    const first = await scanCodexUsage(home, cacheFile);
    expect(first.summary.scannedFiles).toBe(2);
    expect(first.summary.requests).toBe(2);
    expect(first.cacheWritten).toBe(true);
    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(cached.files)).toHaveLength(2);

    // 新增一个文件：缓存命中旧文件，只解析新文件，汇总结果保持一致
    await writeSessions(home, {
      "sessions/2026/09/21/rollout-b.jsonl": [
        metaLine("E:\\work\\demo"),
        contextLine("gpt-5.3-codex"),
        tokenLine("2026-09-21T08:01:00.000Z", { input: 70, cached: 10, output: 7 })
      ]
    });
    const second = await scanCodexUsage(home, cacheFile);
    expect(second.summary.scannedFiles).toBe(3);
    expect(second.summary.requests).toBe(3);
    expect(second.summary.totalTokens).toBe(100 + 10 + 40 + 4 + 70 + 7);

    // 强制重扫结果不变；缓存被整体重建
    const forced = await scanCodexUsage(home, cacheFile, { force: true });
    expect(forced.summary.requests).toBe(3);
    expect(forced.cacheWritten).toBe(true);
  });

  it("prunes cache entries for deleted files and tolerates a corrupt cache", async () => {
    const home = await makeTempDir();
    const cacheFile = join(home, "usage-cache.json");
    await writeSessions(home, {
      "sessions/2026/09/20/rollout-a.jsonl": [metaLine("E:\\x"), tokenLine("2026-09-20T08:01:00.000Z", { input: 1, cached: 0, output: 1 })]
    });
    await scanCodexUsage(home, cacheFile);
    await rm(join(home, "sessions"), { recursive: true, force: true });
    const after = await scanCodexUsage(home, cacheFile);
    expect(after.summary.scannedFiles).toBe(0);
    expect(after.summary.days).toEqual([]);

    await writeFile(cacheFile, "{broken", "utf8");
    await writeSessions(home, {
      "sessions/2026/09/20/rollout-a.jsonl": [metaLine("E:\\x"), tokenLine("2026-09-20T08:01:00.000Z", { input: 1, cached: 0, output: 1 })]
    });
    const recovered = await scanCodexUsage(home, cacheFile);
    expect(recovered.summary.requests).toBe(1);
  });
});

describe("custom pricing, budget and report", () => {
  const fileFixture = (cwd: string, rolloutId: string, date: string, values: [number, number, number, number], mtimeMs = 100): FileUsage => ({
    mtimeMs, size: 1, rolloutId, sessionId: rolloutId, cwd, forked: false,
    days: { [date]: { "gpt-5.6-sol": values } }
  });
  const usageSummary = (): CodexUsageSummary => summarizeUsage({
    "sessions/a.jsonl": fileFixture("E:\\work\\demo", "rollout-a", "2026-09-20", [2, 300, 180, 30]),
    "sessions/b.jsonl": fileFixture("E:\\work\\other", "rollout-b", "2026-09-21", [1, 50, 0, 5], 200)
  });

  it("applies custom prefix pricing before the built-in table", () => {
    const builtIn = modelPrice("gpt-5.6-sol").input;
    setCustomPricing([{ pattern: "gpt-5.6", input: 3, cachedInput: 0.3, output: 12 }]);
    expect(modelPrice("gpt-5.6-sol").input).toBe(3);
    // 更长前缀优先：精确匹配 gpt-5.6-sol 的规则赢过宽泛的 gpt-5.6
    setCustomPricing([{ pattern: "gpt-5.6", input: 3, cachedInput: 0.3, output: 12 }, { pattern: "gpt-5.6-sol", input: 5, cachedInput: 0.5, output: 20 }]);
    expect(modelPrice("gpt-5.6-sol").input).toBe(5);
    setCustomPricing([]);
    expect(modelPrice("gpt-5.6-sol").input).toBe(builtIn);
  });

  it("ranks top sessions with range and instance filters", () => {
    const files = {
      "sessions/a.jsonl": fileFixture("E:\\work\\demo", "rollout-a", "2026-09-20", [2, 300, 180, 30], 100),
      "sessions/b.jsonl": fileFixture("E:\\work\\other", "rollout-b", "2026-09-21", [5, 900, 600, 60], 300),
      "sessions/c.jsonl": fileFixture("E:\\work\\demo", "rollout-c", "2026-09-19", [9, 5000, 4000, 500], 150)
    };
    const home = "C:\\codex";
    const all = topUsageSessions(files, home, {});
    expect(all.map((row) => row.id)).toEqual(["rollout-c", "rollout-b", "rollout-a"]);
    expect(all[0]!.totalTokens).toBe(5500);
    expect(all[0]!.file).toBe(join(home, "sessions", "c.jsonl"));
    // since 过滤：c(09-19) 落在下限之前被排除
    const since = topUsageSessions(files, home, { since: "2026-09-20" });
    expect(since.map((row) => row.id).sort()).toEqual(["rollout-a", "rollout-b"]);
    // instance 过滤：只统计 demo 目录
    const demo = topUsageSessions(files, home, { instance: "E:\\work\\demo" });
    expect(demo.map((row) => row.id).sort()).toEqual(["rollout-a", "rollout-c"]);
    expect(topUsageSessions(files, home, { limit: 1 })).toHaveLength(1);
  });

  it("flags budget exceedance from today's local-date usage", () => {
    const today = localDateKey(Date.now());
    const prefs = { pricing: [], dailyTokenBudget: null as number | null };
    const todaySummary = summarizeUsage({
      "sessions/today.jsonl": fileFixture("E:\\work\\demo", "rollout-today", today, [10, 8000, 0, 200])
    });
    expect(usageBudgetStatus(todaySummary, { pricing: [], dailyTokenBudget: 8000 })).toMatchObject({ todayTokens: 8200, exceeded: true });
    expect(usageBudgetStatus(todaySummary, { pricing: [], dailyTokenBudget: null }).exceeded).toBe(false);
    // 非今天的用量不计入今日预算
    expect(usageBudgetStatus(usageSummary(), prefs).todayTokens).toBe(0);
  });

  it("sanitizes untrusted preference payloads", () => {
    const prefs = sanitizeUsagePreferences({ pricing: [{ pattern: "  gpt-6 ", input: 2, cachedInput: 0.2, output: 20 }, { pattern: "", input: -1, cachedInput: 0, output: 0 }, "junk"], dailyTokenBudget: 5_000_000 });
    expect(prefs.pricing).toEqual([{ pattern: "gpt-6", input: 2, cachedInput: 0.2, output: 20 }]);
    expect(prefs.dailyTokenBudget).toBe(5_000_000);
    expect(sanitizeUsagePreferences({ dailyTokenBudget: -5 }).dailyTokenBudget).toBeNull();
    expect(sanitizeUsagePreferences({ dailyTokenBudget: "5000000" }).dailyTokenBudget).toBeNull();
  });

  it("builds csv and markdown reports", () => {
    const summary = usageSummary();
    const csv = buildUsageReportCsv(summary);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("按模型");
    expect(csv).toContain("按模型,gpt-5.6-sol,350,180,35,3");
    const md = buildUsageReportMarkdown(summary);
    expect(md).toContain("# Codex 用量报表");
    expect(md).toContain("| gpt-5.6-sol |");
    expect(md).toContain("| E:\\work\\other |");
    expect(md).toContain("估算费用：$");
  });
});
