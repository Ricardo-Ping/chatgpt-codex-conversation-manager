import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDailyStats, loadDailyStats, mergeDailyStats, saveDailyStats } from "./stats-daily.js";

const bucket = (chatgptNew = 0, codexNew = 0, chatgptActive = 0, codexActive = 0) => ({ chatgptNew, codexNew, chatgptActive, codexActive });

describe("mergeDailyStats", () => {
  it("keeps the historic peak when a later recount shrinks a day", () => {
    const existing = emptyDailyStats();
    existing.days["2026-09-01"] = bucket(3, 1, 8, 2);
    // 之后会话被删除，回算缩水：取 max 应保留原值
    const merged = mergeDailyStats(existing, { "2026-09-01": bucket(1, 0, 3, 0) });
    expect(merged.days["2026-09-01"]).toEqual(bucket(3, 1, 8, 2));
  });

  it("grows a day when new activity exceeds the recorded peak", () => {
    const existing = emptyDailyStats();
    existing.days["2026-09-01"] = bucket(3, 1, 8, 2);
    const merged = mergeDailyStats(existing, { "2026-09-01": bucket(5, 1, 6, 9) });
    expect(merged.days["2026-09-01"]).toEqual(bucket(5, 1, 8, 9));
  });

  it("is idempotent for identical snapshots", () => {
    const incoming = { "2026-09-02": bucket(2, 2, 4, 4) };
    const once = mergeDailyStats(emptyDailyStats(), incoming);
    expect(mergeDailyStats(once, incoming)).toEqual(once);
  });

  it("tolerates negative or missing fields from callers", () => {
    const merged = mergeDailyStats(emptyDailyStats(), { "2026-09-03": { chatgptNew: -5, codexNew: 0, chatgptActive: 3, codexActive: 0 } as never });
    expect(merged.days["2026-09-03"]).toEqual(bucket(0, 0, 3, 0));
  });
});

describe("loadDailyStats / saveDailyStats", () => {
  it("round-trips through disk and treats unreadable files as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-daily-"));
    try {
      const file = join(dir, "nested", "stats-daily.json");
      const stats = mergeDailyStats(emptyDailyStats(), { "2026-09-04": bucket(7, 0, 9, 1) });
      await saveDailyStats(file, stats);
      const raw = JSON.parse(await readFile(file, "utf8")) as { schemaVersion: number };
      expect(raw.schemaVersion).toBe(1);
      await expect(loadDailyStats(file)).resolves.toEqual(stats);
      await expect(loadDailyStats(join(dir, "missing.json"))).resolves.toEqual(emptyDailyStats());
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects files with an unknown schema version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-daily-"));
    try {
      const file = join(dir, "stats-daily.json");
      await saveDailyStats(file, { schemaVersion: 1, days: {} });
      const broken = JSON.stringify({ schemaVersion: 99, days: {} });
      await (await import("node:fs/promises")).writeFile(file, broken, "utf8");
      await expect(loadDailyStats(file)).resolves.toEqual(emptyDailyStats());
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
