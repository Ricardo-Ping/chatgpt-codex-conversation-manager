import { describe, expect, it } from "vitest";
import { buildDailyBuckets, dateKey, heatLevels, heatRange, heatSeries, heatSummary } from "./stats-model.js";

const DAY = 86_400_000;
const record = (platform: "chatgpt" | "codex", createdAt: number | null, updatedAt: number | null = null) => ({ platform, createdAt, updatedAt });

describe("buildDailyBuckets", () => {
  it("buckets new conversations by createdAt and activity by updatedAt per platform", () => {
    const base = new Date("2026-09-10T00:00:00").getTime();
    const buckets = buildDailyBuckets([
      record("chatgpt", base + 3_600_000, base + 7_200_000),
      record("chatgpt", base + 3_600_000),
      record("codex", base + 3_600_000),
      record("codex", null, base + DAY)
    ]);
    expect(buckets["2026-09-10"]).toEqual({ chatgptNew: 2, codexNew: 1, chatgptActive: 1, codexActive: 0 });
    expect(buckets["2026-09-11"]).toEqual({ chatgptNew: 0, codexNew: 0, chatgptActive: 0, codexActive: 1 });
  });

  it("ignores non-finite timestamps", () => {
    const buckets = buildDailyBuckets([record("chatgpt", Number.NaN, Number.NaN), record("codex", null, null)]);
    expect(Object.keys(buckets)).toEqual([]);
  });
});

describe("heatRange", () => {
  it("aligns the 12-month window to start on Monday", () => {
    const now = new Date("2026-09-13T15:00:00").getTime(); // 周日
    const { start, end } = heatRange("12m", now);
    expect(new Date(end).getDay()).toBe(0);
    expect(new Date(start).getDay()).toBe(1);
    expect(start).toBeLessThan(end);
  });

  it("spans the whole calendar year for year windows", () => {
    const now = new Date("2026-09-13T15:00:00").getTime();
    expect(heatRange("year", now)).toEqual({ start: new Date(2026, 0, 1).getTime(), end: new Date(2026, 11, 31, 23, 59, 59, 999).getTime() });
    expect(heatRange("last-year", now)).toEqual({ start: new Date(2025, 0, 1).getTime(), end: new Date(2025, 11, 31, 23, 59, 59, 999).getTime() });
  });
});

describe("heatSeries / heatSummary", () => {
  it("merges computed and logged values with per-field max", () => {
    const now = new Date("2026-09-13T10:00:00").getTime();
    const range = heatRange("12m", now);
    const computed = { "2026-09-13": { chatgptNew: 2, codexNew: 0, chatgptActive: 3, codexActive: 0 } };
    const log = { schemaVersion: 1 as const, days: { "2026-09-13": { chatgptNew: 1, codexNew: 4, chatgptActive: 9, codexActive: 0 } } };
    const series = heatSeries(range, computed, log);
    const today = series.find((row) => row.date === dateKey(now))!;
    expect(today.bucket).toEqual({ chatgptNew: 2, codexNew: 4, chatgptActive: 9, codexActive: 0 });
  });

  it("summarizes total, streak, best day and average", () => {
    const range = { start: new Date(2026, 8, 1).getTime(), end: new Date(2026, 8, 7, 23, 59, 59, 999).getTime() };
    const series = heatSeries(range, {
      "2026-09-01": { chatgptNew: 2, codexNew: 1, chatgptActive: 0, codexActive: 0 },
      "2026-09-02": { chatgptNew: 1, codexNew: 0, chatgptActive: 0, codexActive: 0 },
      "2026-09-03": { chatgptNew: 0, codexNew: 0, chatgptActive: 5, codexActive: 0 },
      "2026-09-04": { chatgptNew: 4, codexNew: 0, chatgptActive: 0, codexActive: 0 },
      "2026-09-05": { chatgptNew: 1, codexNew: 0, chatgptActive: 0, codexActive: 0 }
    }, null);
    const summary = heatSummary(series);
    expect(summary.total).toBe(9);
    expect(summary.streak).toBe(2); // 9/1-9/2 有新增；9/3 仅活跃不算连续
    expect(summary.best).toEqual({ date: "2026-09-04", count: 4 });
    expect(summary.average).toBeCloseTo(9 / 7, 5);
  });
});

describe("heatLevels", () => {
  it("maps counts onto 4 discrete steps with an enforced minimum peak", () => {
    expect(heatLevels(0, 10)).toBe(0);
    expect(heatLevels(1, 0)).toBe(1);
    expect(heatLevels(10, 8)).toBe(4);
    expect(heatLevels(3, 8)).toBe(2);
    expect(heatLevels(8, 8)).toBe(4);
  });
});
