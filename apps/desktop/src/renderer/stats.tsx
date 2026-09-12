import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { echarts, chartPalette, chartTooltip, type ChartPalette } from "./echarts.js";
import { relativeTime } from "./conversation-viewer.js";
import { Segmented } from "./segmented.js";
import { buildDailyBuckets, heatRange, heatSeries, heatSummary, heatLevels, dateKey, type HeatRecord, type HeatWindow } from "./stats-model.js";
import type { DailyBucket, DailyStatsFile } from "./global.d.js";
import { t } from "./strings.js";

type Platform = "chatgpt" | "codex";

interface StatRecord extends HeatRecord { id: string; title: string; projectId: string; archived: boolean }
interface StatsSnapshot { at: number; records: StatRecord[]; projects: Record<string, string>; daily: DailyStatsFile | null }

// 快照缓存在模块级：切走页面再回来不重新拉取，点「刷新统计」才更新
let snapshotCache: StatsSnapshot | null = null;

const DAY_MS = 86_400_000;
const NINETY_DAYS_MS = 90 * DAY_MS;
const UNTITLED = /^(未命名会话|未命名任务|untitled)/i;

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}

function Chart({ option, height }: { option: echarts.EChartsCoreOption; height: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    const chart = echarts.init(boxRef.current!);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(boxRef.current!);
    return () => { observer.disconnect(); chart.dispose(); chartRef.current = null; };
  }, []);
  useEffect(() => { chartRef.current?.setOption(option, true); }, [option]);
  return <div ref={boxRef} style={{ height }} />;
}

async function gatherSnapshot(): Promise<StatsSnapshot> {
  const records: StatRecord[] = [];
  const projects: Record<string, string> = {};
  const accounts = await window.conversationManager.chatgpt.cachedAccounts();
  for (const account of accounts.accounts) {
    for (const state of ["active", "archived", "scheduled"] as const) {
      const snapshot = await window.conversationManager.chatgpt.cached(account.key, state);
      if (!snapshot) continue;
      Object.assign(projects, snapshot.projects ?? {});
      for (const record of snapshot.records) records.push({ id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, projectId: record.projectId ?? "", platform: "chatgpt", archived: state === "archived" });
    }
    // 缓存快照里项目名可能缺失（旧索引），best-effort 用实时项目列表补全
    try {
      const live = await window.conversationManager.chatgpt.projects(account.key);
      for (const project of live.projects) projects[project.id] = project.name;
    } catch {}
  }
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    do {
      const page = await window.conversationManager.codex.list({ cursor, archived, full: false });
      for (const thread of page.data) records.push({ id: thread.id, title: thread.name || "", createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000, projectId: thread.projectId || "", platform: "codex", archived });
      cursor = page.nextCursor;
    } while (cursor);
  }
  const codexProjects = await window.conversationManager.codex.projects();
  for (const project of codexProjects.projects) projects[project.id] = project.name;
  // 热力图双层合并：先从快照全量回算每日聚合，交给主进程与本地日志逐日取 max，
  // 返回的合并结果兼顾"近期准确"与"清缓存/删除后的历史不丢失"。失败时退回纯回算。
  let daily: DailyStatsFile | null = null;
  try { daily = await window.conversationManager.stats.daily(buildDailyBuckets(records)); } catch {}
  return { at: Date.now(), records, projects, daily };
}

function isUntitled(title: string): boolean {
  const trimmed = title.trim();
  return !trimmed || UNTITLED.test(trimmed);
}

function formatCount(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value); }

function platformName(platform: Platform): string { return platform === "chatgpt" ? "ChatGPT" : "Codex"; }

interface Insight { platform: Platform; count: number; kind: "untitled" | "stale" }
interface StatsSummary {
  total: number; active: number; archived: number; weekly: number;
  byPlatform: Record<Platform, StatRecord[]>;
  insights: Insight[];
}

function summarize(records: StatRecord[]): StatsSummary {
  const byPlatform: Record<Platform, StatRecord[]> = { chatgpt: [], codex: [] };
  for (const record of records) byPlatform[record.platform].push(record);
  const archived = records.filter((record) => record.archived).length;
  const weekly = records.filter((record) => record.createdAt !== null && record.createdAt >= Date.now() - 7 * DAY_MS).length;
  const stale = (record: StatRecord) => !record.archived && record.updatedAt !== null && record.updatedAt < Date.now() - NINETY_DAYS_MS;
  const insights: Insight[] = (["chatgpt", "codex"] as Platform[]).flatMap((platform) => [
    { platform, count: byPlatform[platform].filter((record) => isUntitled(record.title)).length, kind: "untitled" as const },
    { platform, count: byPlatform[platform].filter(stale).length, kind: "stale" as const }
  ]).filter((row) => row.count > 0).sort((a, b) => b.count - a.count);
  return { total: records.length, active: records.length - archived, archived, weekly, byPlatform, insights };
}

function buildTrend(records: StatRecord[], days: number, palette: ChartPalette): echarts.EChartsCoreOption {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 回退 (days-1) 天后重新对齐本地零点：跨夏令时减固定毫秒会让窗口起点偏移 1 小时
  const first = new Date(today.getTime() - (days - 1) * DAY_MS); first.setHours(0, 0, 0, 0);
  const firstStart = first.getTime();
  const labels: string[] = [];
  const chatgptSeries: number[] = [];
  const codexSeries: number[] = [];
  const labelInterval = days <= 7 ? 0 : days <= 30 ? 4 : 13;
  // 标签用 setDate 逐日推进：跨夏令时时固定毫秒递增会让某天重复/消失
  const cursor = new Date(firstStart);
  for (let offset = 0; offset < days; offset++) {
    labels.push(`${cursor.getMonth() + 1}/${cursor.getDate()}`);
    chatgptSeries.push(0); codexSeries.push(0);
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const record of records) {
    if (record.createdAt === null) continue;
    const day = new Date(record.createdAt); day.setHours(0, 0, 0, 0);
    const offset = Math.round((day.getTime() - firstStart) / DAY_MS);
    if (offset < 0 || offset > days - 1) continue;
    if (record.platform === "chatgpt") chatgptSeries[offset] = (chatgptSeries[offset] ?? 0) + 1; else codexSeries[offset] = (codexSeries[offset] ?? 0) + 1;
  }
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, ...chartTooltip(palette) },
    legend: { top: 0, right: 0, icon: "roundRect", itemWidth: 12, itemHeight: 8, textStyle: { color: palette.muted, fontSize: 12 } },
    grid: { left: 34, right: 8, top: 34, bottom: 22 },
    xAxis: { type: "category", data: labels, axisLabel: { color: palette.muted, interval: labelInterval }, axisLine: { lineStyle: { color: palette.border } }, axisTick: { show: false } },
    yAxis: { type: "value", minInterval: 1, axisLabel: { color: palette.muted }, splitLine: { lineStyle: { color: palette.split } } },
    series: [
      { name: "ChatGPT", type: "bar", stack: "new", barMaxWidth: 16, itemStyle: { color: palette.chat }, data: chatgptSeries },
      { name: "Codex", type: "bar", stack: "new", barMaxWidth: 16, itemStyle: { color: palette.codex, borderRadius: [3, 3, 0, 0] }, data: codexSeries }
    ]
  };
}

function buildShare(summary: StatsSummary, palette: ChartPalette): echarts.EChartsCoreOption {
  return {
    tooltip: { trigger: "item", formatter: "{b}：{c} 条（{d}%）", ...chartTooltip(palette) },
    legend: { bottom: 0, icon: "circle", itemWidth: 10, itemHeight: 10, textStyle: { color: palette.muted, fontSize: 12 } },
    title: {
      text: String(summary.total),
      subtext: t("总会话"),
      left: "center", top: "34%",
      textStyle: { color: palette.text, fontSize: 24, fontWeight: 700 },
      subtextStyle: { color: palette.muted, fontSize: 11 }
    },
    series: [{
      type: "pie", radius: ["52%", "70%"], center: ["50%", "42%"], avoidLabelOverlap: false,
      label: { show: true, formatter: "{b}\n{d}%", color: palette.muted, fontSize: 11, lineHeight: 15 },
      labelLine: { length: 12, length2: 8, lineStyle: { color: palette.border } },
      emphasis: { scale: false },
      itemStyle: { borderColor: palette.surface, borderWidth: 3 },
      data: [
        { name: "ChatGPT", value: summary.byPlatform.chatgpt.length, itemStyle: { color: palette.chat } },
        { name: "Codex", value: summary.byPlatform.codex.length, itemStyle: { color: palette.codex } }
      ]
    }]
  };
}

function buildProjectBars(snapshot: StatsSnapshot, top: number, palette: ChartPalette): echarts.EChartsCoreOption {
  const counts = new Map<string, number>();
  for (const record of snapshot.records) {
    if (!record.projectId) continue;
    counts.set(record.projectId, (counts.get(record.projectId) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).reverse();
  const label = (id: string) => snapshot.projects[id] || `${t("未命名项目")} ${id.replace(/^g-p-/, "").slice(0, 8)}`;
  return {
    tooltip: { trigger: "item", formatter: (params: { name?: string; value?: number }) => `${params.name}：${params.value} 条`, ...chartTooltip(palette) },
    grid: { left: 8, right: 24, top: 8, bottom: 24, containLabel: true },
    xAxis: { type: "value", minInterval: 1, axisLabel: { color: palette.muted }, splitLine: { lineStyle: { color: palette.split } } },
    yAxis: { type: "category", data: rows.map(([id]) => label(id)), axisLabel: { color: palette.muted, width: 130, overflow: "truncate" }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.border } } },
    series: [{ type: "bar", barMaxWidth: 14, itemStyle: { color: palette.brand, borderRadius: [0, 7, 7, 0] }, data: rows.map(([, count]) => count) }]
  };
}

function shortDate(key: string): string {
  const [, month, day] = key.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function buildHeatmap(daily: DailyStatsFile | null, computed: Record<string, DailyBucket>, selected: HeatWindow, palette: ChartPalette): echarts.EChartsCoreOption {
  const range = heatRange(selected);
  const rows = heatSeries(range, computed, daily);
  const peak = rows.reduce((max, row) => Math.max(max, row.bucket.chatgptNew + row.bucket.codexNew), 0);
  const steps = palette.heat.steps;
  const data = rows
    .map(({ date, bucket }) => ({ date, level: heatLevels(bucket.chatgptNew + bucket.codexNew, peak), total: bucket.chatgptNew + bucket.codexNew, chatgpt: bucket.chatgptNew, codex: bucket.codexNew, active: bucket.chatgptActive + bucket.codexActive }))
    .filter((item) => item.level > 0)
    .map(({ date, level, total, chatgpt, codex, active }) => ({ value: [date, level], itemStyle: { color: steps[level - 1] }, meta: { date, total, chatgpt, codex, active } }));
  const startLabel = dateKey(range.start);
  const endLabel = dateKey(range.end);
  return {
    tooltip: {
      trigger: "item",
      formatter: (params: { data?: { meta?: { date: string; total: number; chatgpt: number; codex: number; active: number } } }) => {
        const meta = params.data?.meta;
        if (!meta) return "";
        return `${shortDate(meta.date)} · ${t("新增 {n} 条（ChatGPT {a} · Codex {c}）· 活跃 {v} 条", { n: meta.total, a: meta.chatgpt, c: meta.codex, v: meta.active })}`;
      },
      ...chartTooltip(palette)
    },
    calendar: {
      top: 22, left: 30, right: 8,
      cellSize: ["auto", 13],
      range: [startLabel, endLabel],
      itemStyle: { color: palette.heat.empty, borderWidth: 2.5, borderColor: palette.surface, borderRadius: 3 },
      dayLabel: { color: palette.muted, fontSize: 10, firstDay: 1, nameMap: ["", t("一"), "", t("三"), "", t("五"), ""] },
      monthLabel: { color: palette.muted, fontSize: 10 },
      yearLabel: { show: false }
    },
    series: [{
      type: "heatmap", coordinateSystem: "calendar",
      data,
      itemStyle: { borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: palette.text, borderWidth: 1 } }
    }]
  };
}

type TrendRange = "7" | "30" | "90";
const TREND_RANGES: Array<[TrendRange, string]> = [["7", "近 7 天"], ["30", "近 30 天"], ["90", "近 90 天"]];
const HEAT_WINDOWS: Array<[HeatWindow, string]> = [["12m", "近 12 个月"], ["year", "今年"], ["last-year", "去年"]];

function EmptyChart() {
  return <div className="chart-empty"><strong>{t("暂无数据")}</strong><span>{t("先在 ChatGPT 或 Codex 页完成一次同步，再回来看统计。")}</span></div>;
}

export function StatsPage({ onNavigate }: { onNavigate(page: Platform): void }) {
  const dark = useDarkMode();
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(snapshotCache);
  const [loading, setLoading] = useState(false);
  const [trendRange, setTrendRange] = useState<TrendRange>("30");
  const [heatWindow, setHeatWindow] = useState<HeatWindow>("12m");
  const refresh = useCallback(() => {
    setLoading(true);
    void gatherSnapshot().then((next) => { snapshotCache = next; setSnapshot(next); }).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (!snapshotCache) refresh(); }, [refresh]);

  const palette = useMemo(chartPalette, [dark]);
  const summary = useMemo(() => summarize(snapshot?.records ?? []), [snapshot]);
  const computedBuckets = useMemo(() => buildDailyBuckets(snapshot?.records ?? []), [snapshot]);
  const trend = useMemo(() => buildTrend(snapshot?.records ?? [], Number(trendRange), palette), [snapshot, trendRange, palette]);
  const share = useMemo(() => buildShare(summary, palette), [summary, palette]);
  const projectBars = useMemo(() => snapshot ? buildProjectBars(snapshot, 8, palette) : null, [snapshot, palette]);
  const heatmap = useMemo(() => buildHeatmap(snapshot?.daily ?? null, computedBuckets, heatWindow, palette), [snapshot, computedBuckets, heatWindow, palette]);
  const heatStats = useMemo(() => heatSummary(heatSeries(heatRange(heatWindow), computedBuckets, snapshot?.daily ?? null)), [snapshot, computedBuckets, heatWindow]);
  const hasData = summary.total > 0;

  return <section className="stats-page">
    <header className="stats-head">
      <div>
        <p className="eyebrow">{t("统计洞察")}</p>
        <h1>{t("本地会话统计")}</h1>
        <p className="stats-scope">{t("基于本地索引 · 最近同步 {time}", { time: snapshot ? relativeTime(snapshot.at) : t("尚未同步") })}</p>
      </div>
      <button type="button" className="stats-refresh" disabled={loading} onClick={refresh}>{loading ? t("统计中…") : t("刷新统计")}</button>
    </header>

    <div className="kpi-grid">
      <article className="kpi-card"><strong>{formatCount(summary.total)}</strong><span>{t("总会话")}</span></article>
      <article className="kpi-card"><strong>{formatCount(summary.active)}</strong><span>{t("未归档")}</span></article>
      <article className="kpi-card"><strong>{formatCount(summary.archived)}</strong><span>{t("已归档")}</span></article>
      <article className="kpi-card"><strong>{formatCount(summary.weekly)}</strong><span>{t("本周新增（7 天）")}</span></article>
    </div>

    <article className="stats-card">
      <h2>{t("会话热力图")}
        <span className="head-extra">
          <Segmented<HeatWindow> value={heatWindow} options={HEAT_WINDOWS.map(([value, label]) => [value, t(label)] as [HeatWindow, string])} onChange={setHeatWindow} aria-label={t("会话热力图")} />
          <span className="heat-legend" title={`${t("少")} → ${t("多")}`}>{t("少")}<i></i><i></i><i></i><i></i><i></i>{t("多")}</span>
        </span>
      </h2>
      {hasData ? <Chart option={heatmap} height={186} /> : <EmptyChart />}
      {hasData && <div className="heat-stats">
        <span>{t("总计")}<b>{formatCount(heatStats.total)}</b></span>
        <span>{t("最长连续")}<b>{t("{n} 天", { n: heatStats.streak })}</b></span>
        <span>{t("最活跃的一天")}<b>{heatStats.best ? `${shortDate(heatStats.best.date)} · ${heatStats.best.count}` : "—"}</b></span>
        <span>{t("日均")}<b>{heatStats.average.toFixed(1)}</b></span>
      </div>}
    </article>

    <article className="stats-card">
      <h2>{t("近 {n} 天新增（按平台）", { n: Number(trendRange) })}
        <span className="head-extra">
          <Segmented<TrendRange> value={trendRange} options={TREND_RANGES.map(([value, label]) => [value, t(label)] as [TrendRange, string])} onChange={setTrendRange} aria-label={t("近 {n} 天新增（按平台）", { n: Number(trendRange) })} />
        </span>
      </h2>
      {hasData ? <Chart option={trend} height={260} /> : <EmptyChart />}
    </article>

    <div className="stats-row">
      <article className="stats-card">
        <h2>{t("平台占比")}</h2>
        {hasData ? <Chart option={share} height={240} /> : <EmptyChart />}
      </article>
      <article className="stats-card">
        <h2>{t("项目 Top 8")}</h2>
        {hasData && projectBars ? <Chart option={projectBars} height={240} /> : <EmptyChart />}
      </article>
    </div>

    <article className="stats-card insights">
      <h2>{t("洞察建议")}</h2>
      {summary.insights.length ? <ul className="insight-list">
        {summary.insights.map((insight) => <li key={`${insight.platform}-${insight.kind}`}>
          <button type="button" onClick={() => onNavigate(insight.platform)}>
            <span className="insight-dot"></span>
            {insight.kind === "untitled"
              ? t("{platform} 有 {n} 个未命名会话，点击前往重命名", { platform: platformName(insight.platform), n: insight.count })
              : t("{platform} 有 {n} 条超过 90 天未动，建议归档", { platform: platformName(insight.platform), n: insight.count })}
          </button>
        </li>)}
      </ul> : <p className="insight-empty">{t("当前没有需要处理的会话")}</p>}
    </article>
  </section>;
}
