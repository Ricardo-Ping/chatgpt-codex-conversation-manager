import type { DailyBucket, DailyStatsFile } from "./global.d.js";

export interface HeatRecord { createdAt: number | null; updatedAt: number | null; platform: "chatgpt" | "codex" }

export type HeatWindow = "12m" | "year" | "last-year";

/** 本地时区的 YYYY-MM-DD 键，与 stats-daily.json 的存储格式一致 */
export function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 从会话快照全量回算每日聚合（新增按 createdAt、活跃按 updatedAt）。
 * 这是热力图的"回溯层"：不依赖任何积累，首次打开即可看到完整历史。 */
export function buildDailyBuckets(records: HeatRecord[]): Record<string, DailyBucket> {
  const days: Record<string, DailyBucket> = {};
  const bucket = (key: string): DailyBucket => days[key] ??= { chatgptNew: 0, codexNew: 0, chatgptActive: 0, codexActive: 0 };
  for (const record of records) {
    const isNew = record.platform === "chatgpt" ? "chatgptNew" : "codexNew";
    const isActive = record.platform === "chatgpt" ? "chatgptActive" : "codexActive";
    if (record.createdAt !== null && Number.isFinite(record.createdAt)) bucket(dateKey(record.createdAt))[isNew] += 1;
    if (record.updatedAt !== null && Number.isFinite(record.updatedAt)) bucket(dateKey(record.updatedAt))[isActive] += 1;
  }
  return days;
}

/** 热力图窗口：近 12 个月（起点对齐周一）、今年、去年。返回本地时区的日起止时间戳。 */
export function heatRange(selected: HeatWindow, now = Date.now()): { start: number; end: number } {
  const today = startOfDay(now);
  if (selected === "12m") {
    // 回退 363 天后必须重新对齐本地零点：跨夏令时边界减固定毫秒会偏移 1 小时
    const start = startOfDay(today - 363 * 86_400_000);
    const weekday = (new Date(start).getDay() + 6) % 7; // 周一=0
    return { start: startOfDay(start - weekday * 86_400_000), end: today };
  }
  const year = new Date(today).getFullYear() + (selected === "last-year" ? -1 : 0);
  return { start: new Date(year, 0, 1).getTime(), end: new Date(year, 11, 31, 23, 59, 59, 999).getTime() };
}

/** 窗口内的逐日序列：合并"索引回算"与"本地日志"，逐字段取 max——
 * 日志钉住历史峰值（删除/清缓存造成的缩水不算数），回算保证近期数据始终准确。
 * 用 setDate 逐日推进而不是加固定毫秒：夏令时地区一天可能是 23/25 小时。 */
export function heatSeries(range: { start: number; end: number }, computed: Record<string, DailyBucket>, log: DailyStatsFile | null): Array<{ date: string; bucket: DailyBucket }> {
  const series: Array<{ date: string; bucket: DailyBucket }> = [];
  const cursor = new Date(range.start);
  cursor.setHours(0, 0, 0, 0);
  const end = startOfDay(range.end);
  while (cursor.getTime() <= end) {
    const key = dateKey(cursor.getTime());
    const computedBucket = computed[key];
    const loggedBucket = log?.days[key];
    series.push({
      date: key,
      bucket: {
        chatgptNew: Math.max(computedBucket?.chatgptNew ?? 0, loggedBucket?.chatgptNew ?? 0),
        codexNew: Math.max(computedBucket?.codexNew ?? 0, loggedBucket?.codexNew ?? 0),
        chatgptActive: Math.max(computedBucket?.chatgptActive ?? 0, loggedBucket?.chatgptActive ?? 0),
        codexActive: Math.max(computedBucket?.codexActive ?? 0, loggedBucket?.codexActive ?? 0)
      }
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

export interface HeatSummary { total: number; streak: number; best: { date: string; count: number } | null; average: number }

/** 热力图头部指标：窗口总数、最长连续天数（至少 1 条新增）、最活跃的一天、日均 */
export function heatSummary(series: Array<{ date: string; bucket: DailyBucket }>): HeatSummary {
  let total = 0;
  let streak = 0;
  let running = 0;
  let best: { date: string; count: number } | null = null;
  for (const { date, bucket } of series) {
    const count = bucket.chatgptNew + bucket.codexNew;
    total += count;
    running = count > 0 ? running + 1 : 0;
    streak = Math.max(streak, running);
    if (!best || count > best.count) best = { date, count };
  }
  return { total, streak, best: best && best.count > 0 ? best : null, average: series.length ? total / series.length : 0 };
}

/** 把新增计数映射到 4 档色阶（0 档 = 无数据底色）。阈值按峰值等分，峰值至少为 4，
 * 保证每档都能出现且阈值单调。 */
export function heatLevels(count: number, peak: number): number {
  if (count <= 0) return 0;
  const ceiling = Math.max(4, peak);
  return Math.min(4, Math.ceil((count / ceiling) * 4));
}
