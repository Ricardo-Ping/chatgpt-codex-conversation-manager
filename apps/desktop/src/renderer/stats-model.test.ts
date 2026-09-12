import { describe, expect, it } from "vitest";
import { buildDailyBuckets, dateKey, heatLevels, heatRange, heatSeries, heatSummary, allTimeStreak, countLateNight, computeBadges, mergeNewCounts } from "./stats-model.js";

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

describe("allTimeStreak", () => {
  it("counts consecutive days across month boundaries and resets on gaps", () => {
    const counts = {
      "2026-01-30": 1, "2026-01-31": 2, "2026-02-01": 1, // 跨月连续 3 天
      "2026-02-10": 5, "2026-02-11": 1, "2026-02-13": 2  // 2 天后断档
    };
    expect(allTimeStreak(counts)).toBe(3);
  });

  it("merges computed and logged counts taking the max before judging", () => {
    const computed = { "2026-03-01": { chatgptNew: 0, codexNew: 0, chatgptActive: 4, codexActive: 0 } };
    const log = { schemaVersion: 1 as const, days: { "2026-03-01": { chatgptNew: 2, codexNew: 0, chatgptActive: 0, codexActive: 0 } } };
    const counts = mergeNewCounts(computed, log);
    expect(counts["2026-03-01"]).toBe(2);
    expect(allTimeStreak(counts)).toBe(1);
  });

  it("returns zero for empty history", () => {
    expect(allTimeStreak({})).toBe(0);
    expect(allTimeStreak({ "2026-03-01": 0 })).toBe(0);
  });
});

describe("countLateNight", () => {
  it("counts a record once when either timestamp falls between midnight and 5am", () => {
    const records = [
      { platform: "chatgpt" as const, createdAt: new Date(2026, 8, 13, 2, 30).getTime(), updatedAt: new Date(2026, 8, 13, 14).getTime() },
      { platform: "codex" as const, createdAt: new Date(2026, 8, 12, 23).getTime(), updatedAt: new Date(2026, 8, 13, 4, 59).getTime() },
      { platform: "codex" as const, createdAt: new Date(2026, 8, 13, 5).getTime(), updatedAt: null } // 5 点整不算深夜
    ];
    expect(countLateNight(records)).toBe(2);
  });
});

describe("computeBadges", () => {
  const metrics = { total: 120, archived: 30, streak: 9, lateNight: 4, chatgptCount: 100, codexCount: 20 };

  it("earns badges whose target is met and tracks progress for the rest", () => {
    const badges = computeBadges(metrics);
    const byId = Object.fromEntries(badges.map((badge) => [badge.id, badge]));
    expect(byId["first-sync"]).toMatchObject({ earned: true, target: 1 });
    expect(byId["hundred-club"]).toMatchObject({ earned: true, current: 100, target: 100 });
    expect(byId["five-hundred"]).toMatchObject({ earned: false, current: 120, target: 500 });
    expect(byId["streak-7"]).toMatchObject({ earned: true, current: 7, target: 7 });
    expect(byId["streak-30"]).toMatchObject({ earned: false, current: 9, target: 30 });
    expect(byId["cleaner-100"]).toMatchObject({ earned: false, current: 30, target: 100 });
    expect(byId["night-owl"]).toMatchObject({ earned: true, current: 3, target: 3 });
    expect(byId["dual-wield"]).toMatchObject({ earned: true, current: 10, target: 10 }); // 双平台取较小值
    expect(badges).toHaveLength(8);
  });

  it("caps displayed progress at the target once earned", () => {
    const badges = computeBadges({ ...metrics, total: 900 });
    expect(badges.find((badge) => badge.id === "five-hundred")?.current).toBe(500);
  });
});
