import { describe, expect, it } from "vitest";
import { buildUsageView, formatRequests, formatTokens, formatUsd, instanceName, sharePercent } from "./codex-usage-model.js";
import type { CodexUsageSummary } from "./global.d.js";

const cell = (requests: number, input: number, cachedInput: number, output: number) => ({ requests, input, cachedInput, output, costUsd: 0.5 * requests });

const dayKey = (offsetDays: number): string => {
  const date = new Date(Date.now() - offsetDays * 86_400_000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const summary = (): CodexUsageSummary => ({
  generatedAt: 0,
  scannedFiles: 3,
  sessions: 3,
  forkedSessions: 1,
  requests: 6,
  inputTokens: 320,
  cachedInputTokens: 180,
  outputTokens: 35,
  totalTokens: 355,
  costUsd: 2.5,
  days: [
    { date: dayKey(9), instances: { "E:\\work\\demo": { "gpt-5.3-codex": cell(1, 10, 0, 1) } } },
    { date: dayKey(1), instances: { "E:\\work\\demo": { "gpt-5.3-codex": cell(2, 100, 60, 10), "gpt-6-luna": cell(1, 50, 0, 5) }, "C:\\other": { "gpt-5.3-codex": cell(1, 160, 120, 19) } } }
  ],
  models: [],
  instances: []
});

describe("formatTokens / formatRequests / formatUsd", () => {
  it("uses 亿/万 units in Chinese and compact units in English", () => {
    expect(formatTokens(135_000_000, "zh")).toBe("1.35 亿");
    expect(formatTokens(587_000, "zh")).toBe("58.7 万");
    expect(formatTokens(999, "zh")).toBe("999");
    expect(formatTokens(135_000_000, "en")).toBe("135M");
    expect(formatTokens(587_000, "en")).toBe("587K");
    expect(formatTokens(2_540_000_000, "en")).toBe("2.54B");
  });
  it("formats requests and USD", () => {
    expect(formatRequests(1068)).toBe("1,068");
    expect(formatUsd(70.351412)).toBe("$70.3514");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("instanceName", () => {
  it("returns the basename for both slash styles", () => {
    expect(instanceName("E:\\work\\demo")).toBe("demo");
    expect(instanceName("/home/user/project-x")).toBe("project-x");
    expect(instanceName("")).toBe("");
  });
});

describe("buildUsageView", () => {
  it("aggregates totals, series, models and instances for the whole range", () => {
    const view = buildUsageView(summary(), "all", "all");
    expect(view.totals.requests).toBe(5);
    expect(view.totals.totalTokens).toBe(320 + 35);
    expect(view.totals.costUsd).toBeCloseTo(2.5, 9);
    expect(view.series.map((day) => day.date)).toEqual([dayKey(9), dayKey(1)]);
    // dayRows 是 newest-first
    expect(view.dayRows[0]!.date).toBe(dayKey(1));
    expect(view.models.map((row) => row.key)).toEqual(["gpt-5.3-codex", "gpt-6-luna"]);
    expect(view.models[0]!.totalTokens).toBe(300);
    // 按合计 Tokens 降序：other 179 > demo 176；表格列显示 basename
    expect(view.instances.map((row) => row.name)).toEqual(["other", "demo"]);
    expect(view.instances.map((row) => row.key)).toEqual(["C:\\other", "E:\\work\\demo"]);
  });

  it("filters by instance", () => {
    const view = buildUsageView(summary(), "all", "E:\\work\\demo");
    expect(view.totals.requests).toBe(4);
    expect(view.totals.input).toBe(160);
    expect(view.instances).toHaveLength(1);
    expect(view.instances[0]!.key).toBe("E:\\work\\demo");
    expect(view.models.map((row) => row.key)).toEqual(["gpt-5.3-codex", "gpt-6-luna"]);
  });

  it("applies the rolling cutoff for day-based ranges", () => {
    const view = buildUsageView(summary(), "7", "all");
    expect(view.series.map((day) => day.date)).toEqual([dayKey(1)]);
    expect(view.totals.requests).toBe(4);
  });

  it("returns an empty view without data", () => {
    const view = buildUsageView(null, "7", "all");
    expect(view.totals.requests).toBe(0);
    expect(view.series).toEqual([]);
    expect(view.models).toEqual([]);
  });
});

describe("sharePercent", () => {
  it("maps values to a visible bar width", () => {
    expect(sharePercent(50, 100)).toBe(50);
    expect(sharePercent(1, 100)).toBe(4);
    expect(sharePercent(10, 0)).toBe(0);
  });
});
