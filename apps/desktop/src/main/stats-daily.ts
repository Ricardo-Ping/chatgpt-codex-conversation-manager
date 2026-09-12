import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DailyBucket { chatgptNew: number; codexNew: number; chatgptActive: number; codexActive: number }
export interface DailyStatsFile { schemaVersion: 1; days: Record<string, DailyBucket>; badges?: Record<string, string> }

/** 每日会话聚合计数的本地持久化（<userData>/stats-daily.json）。
 * 热力图的数据分两层：渲染端可随时从缓存索引按 createdAt/updatedAt 全量回算历史；
 * 本文件的价值在于把历史"钉住"——清空缓存后历史仍在，且"当天活跃、后来被删除"
 * 的会话活动不会从统计里消失。只存计数，不存任何会话内容。
 * badges 字段记录成就徽章的获得时间（ISO 字符串）：徽章一旦获得永久保留，
 * 不随后续缓存清理/删除导致的指标回落而消失。 */

export function emptyDailyStats(): DailyStatsFile { return { schemaVersion: 1, days: {} }; }

/** 逐日逐字段取最大值合并。索引重算的历史计数只会因记录消失（删除/清理缓存）
 * 而"缩水"，取 max 保住真实峰值；同一份快照重复合并结果不变，天然幂等。 */
/** 合并逻辑对 badges 字段透明保留，避免合并日期时丢失成就记录 */
export function mergeDailyStats(existing: DailyStatsFile, incoming: Record<string, DailyBucket>): DailyStatsFile {
  const days = { ...existing.days };
  for (const [date, bucket] of Object.entries(incoming)) {
    const current = days[date] ?? { chatgptNew: 0, codexNew: 0, chatgptActive: 0, codexActive: 0 };
    days[date] = {
      chatgptNew: Math.max(current.chatgptNew, bucket.chatgptNew || 0),
      codexNew: Math.max(current.codexNew, bucket.codexNew || 0),
      chatgptActive: Math.max(current.chatgptActive, bucket.chatgptActive || 0),
      codexActive: Math.max(current.codexActive, bucket.codexActive || 0)
    };
  }
  return { schemaVersion: 1, days, ...(existing.badges ? { badges: existing.badges } : {}) };
}

/** 成就合并：同一徽章保留最早的获得时间（ISO 字符串的字典序即时间序）。 */
export function mergeBadgeAwards(existing: DailyStatsFile, awards: Record<string, string>): DailyStatsFile {
  const merged: Record<string, string> = { ...(existing.badges ?? {}) };
  for (const [id, earnedAt] of Object.entries(awards)) {
    const current = merged[id];
    merged[id] = current && current <= earnedAt ? current : earnedAt;
  }
  return { schemaVersion: 1, days: existing.days, badges: merged };
}

export async function loadDailyStats(file: string): Promise<DailyStatsFile> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as DailyStatsFile;
    if (value.schemaVersion !== 1 || !value.days || typeof value.days !== "object") return emptyDailyStats();
    return value;
  } catch { return emptyDailyStats(); }
}

export async function saveDailyStats(file: string, stats: DailyStatsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(stats)}\n`, "utf8");
  await rename(temp, file);
}
