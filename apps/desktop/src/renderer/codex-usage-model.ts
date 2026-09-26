import type { CodexUsageCell, CodexUsageDay, CodexUsageSummary, CodexUsageTotals } from "./global.d.js";
import type { Lang } from "./strings.js";

/** Codex 用量视图的纯逻辑：时间范围/实例筛选、聚合与数字格式化。
 * 全部输入来自主进程的 CodexUsageSummary，这里不做任何 I/O。 */

export type UsageRange = "7" | "30" | "90" | "all";
export type UsageDimension = "total" | "model";
export const USAGE_RANGES: Array<[UsageRange, string]> = [["7", "近 7 天"], ["30", "近 30 天"], ["90", "近 90 天"], ["all", "全部"]];

/** 范围筛选的本地日期下限（YYYY-MM-DD，含当天）；range="all" 返回空串表示不设下限。
 * cutoff 用 setDate 逐日回退后对齐本地零点：跨夏令时减固定毫秒会让日期偏移一天 */
export function rangeCutoffKey(range: UsageRange, now = Date.now()): string {
  if (range === "all") return "";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (Number(range) - 1));
  return localDateKey(start.getTime());
}

/** 中文习惯用亿/万（与官方账单口径一致），英文用 K/M/B 紧凑记法 */
export function formatTokens(value: number, lang: Lang): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (lang === "zh") {
    if (value >= 1e8) return `${stripZeros((value / 1e8).toFixed(2))} 亿`;
    if (value >= 1e4) return `${stripZeros((value / 1e4).toFixed(1))} 万`;
    return String(Math.round(value));
  }
  if (value >= 1e9) return `${stripZeros((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${stripZeros((value / 1e6).toFixed(1))}M`;
  if (value >= 1e3) return `${stripZeros((value / 1e3).toFixed(1))}K`;
  return String(Math.round(value));
}

function stripZeros(text: string): string {
  return text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatRequests(value: number): string {
  return Math.round(value).toLocaleString();
}

/** $70.3514 风格：小额保留 4 位小数，百位以上收敛到 2 位/整数 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value >= 1000) return `$${Math.round(value).toLocaleString()}`;
  if (value >= 100) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

export function instanceName(cwd: string): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export type UsageViewTotals = CodexUsageTotals;
export interface UsageViewRow extends CodexUsageTotals { key: string; name: string; fullName: string }
export interface UsageViewDay extends CodexUsageTotals { date: string }

export interface UsageView {
  totals: UsageViewTotals;
  series: UsageViewDay[];
  dayRows: UsageViewDay[];
  models: UsageViewRow[];
  instances: UsageViewRow[];
  /** 每日×模型合计 Tokens / 请求（按 modelSeries 顺序对齐 series 索引），供堆叠图使用 */
  modelSeriesTokens: Array<{ model: string; data: number[] }>;
  modelSeriesRequests: Array<{ model: string; data: number[] }>;
}

const zeroTotals = (): UsageViewTotals => ({ requests: 0, input: 0, cachedInput: 0, output: 0, costUsd: 0, totalTokens: 0 });

function addCell(target: UsageViewTotals, cell: CodexUsageCell): void {
  target.requests += cell.requests;
  target.input += cell.input;
  target.cachedInput += cell.cachedInput;
  target.output += cell.output;
  target.costUsd += cell.costUsd;
  target.totalTokens += cell.input + cell.output;
}

/** 范围 + 实例筛选后的视图。days 升序、dayRows 降序（表格 newest-first）、
 * models / instances 按合计 Tokens 降序。range="all" 表示不设下限。 */
export function buildUsageView(summary: CodexUsageSummary | null, range: UsageRange, instance: string): UsageView {
  const view: UsageView = { totals: zeroTotals(), series: [], dayRows: [], models: [], instances: [], modelSeriesTokens: [], modelSeriesRequests: [] };
  if (!summary) return view;
  const cutoff = rangeCutoffKey(range);
  const models = new Map<string, UsageViewTotals>();
  const instances = new Map<string, UsageViewTotals>();
  const instanceBucket = (cwd: string): UsageViewTotals => {
    let bucket = instances.get(cwd);
    if (!bucket) { bucket = zeroTotals(); instances.set(cwd, bucket); }
    return bucket;
  };
  // 每日×模型：按天收集，天通过完备性检查后一起落位（索引与 series 对齐）
  const modelSeriesTokens = new Map<string, number[]>();
  const modelSeriesRequests = new Map<string, number[]>();
  for (const day of summary.days as CodexUsageDay[]) {
    if (cutoff && day.date < cutoff) continue;
    const dayTotals = zeroTotals();
    const dayModels = new Map<string, { tokens: number; requests: number }>();
    for (const [cwd, cells] of Object.entries(day.instances)) {
      if (instance !== "all" && cwd !== instance) continue;
      for (const [model, cell] of Object.entries(cells)) {
        addCell(dayTotals, cell);
        let modelBucket = models.get(model);
        if (!modelBucket) { modelBucket = zeroTotals(); models.set(model, modelBucket); }
        addCell(modelBucket, cell);
        addCell(instanceBucket(cwd), cell);
        const perDay = dayModels.get(model) ?? { tokens: 0, requests: 0 };
        perDay.tokens += cell.input + cell.output;
        perDay.requests += cell.requests;
        dayModels.set(model, perDay);
      }
    }
    if (dayTotals.requests > 0 || dayTotals.totalTokens > 0) {
      const index = view.series.length;
      view.series.push({ date: day.date, ...dayTotals });
      view.dayRows.unshift({ date: day.date, ...dayTotals });
      for (const [model, perDay] of dayModels) {
        let tokens = modelSeriesTokens.get(model);
        if (!tokens) { tokens = []; modelSeriesTokens.set(model, tokens); }
        let requests = modelSeriesRequests.get(model);
        if (!requests) { requests = []; modelSeriesRequests.set(model, requests); }
        tokens[index] = perDay.tokens;
        requests[index] = perDay.requests;
      }
    }
    addCell(view.totals, dayTotals);
  }
  const stackSeries = (source: Map<string, number[]>): Array<{ model: string; data: number[] }> =>
    [...source.entries()]
      .map(([model, values]) => ({ model, data: Array.from({ length: view.series.length }, (_, index) => values[index] ?? 0) }))
      .sort((a, b) => {
        const sum = (data: number[]) => data.reduce((sum2, value) => sum2 + value, 0);
        return sum(b.data) - sum(a.data);
      });
  view.modelSeriesTokens = stackSeries(modelSeriesTokens);
  view.modelSeriesRequests = stackSeries(modelSeriesRequests);
  view.models = [...models.entries()].map(([key, totals]) => ({ key, name: key || "", fullName: key, ...totals })).sort((a, b) => b.totalTokens - a.totalTokens);
  view.instances = [...instances.entries()].map(([key, totals]) => ({ key, name: instanceName(key), fullName: key, ...totals })).sort((a, b) => b.totalTokens - a.totalTokens);
  return view;
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 表格里的合计占比条宽度（0-100），max 为该表最大合计值 */
export function sharePercent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(4, Math.round((value / max) * 100));
}
