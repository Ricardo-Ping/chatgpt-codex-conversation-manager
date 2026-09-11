import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { echarts, chartPalette, type ChartPalette } from "./echarts.js";
import { relativeTime } from "./conversation-viewer.js";
import { t } from "./strings.js";

type Platform = "chatgpt" | "codex";

interface StatRecord { id: string; title: string; createdAt: number | null; updatedAt: number | null; projectId: string; platform: Platform; archived: boolean }
interface StatsSnapshot { at: number; records: StatRecord[]; projects: Record<string, string> }

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
  return { at: Date.now(), records, projects };
}

function isUntitled(title: string): boolean {
  const trimmed = title.trim();
  return !trimmed || UNTITLED.test(trimmed);
}

function formatCount(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value); }

function platformName(platform: Platform): string { return platform === "chatgpt" ? "ChatGPT" : "Codex"; }

interface Insight { platform: Platform; count: number; kind: "untitled" | "stale" }
interface StatsSummary {
  total: number; active: number; archived: number; untitled: number;
  byPlatform: Record<Platform, StatRecord[]>;
  insights: Insight[];
}

function summarize(records: StatRecord[]): StatsSummary {
  const byPlatform: Record<Platform, StatRecord[]> = { chatgpt: [], codex: [] };
  for (const record of records) byPlatform[record.platform].push(record);
  const archived = records.filter((record) => record.archived).length;
  const stale = (record: StatRecord) => !record.archived && record.updatedAt !== null && record.updatedAt < Date.now() - NINETY_DAYS_MS;
  const insights: Insight[] = (["chatgpt", "codex"] as Platform[]).flatMap((platform) => [
    { platform, count: byPlatform[platform].filter((record) => isUntitled(record.title)).length, kind: "untitled" as const },
    { platform, count: byPlatform[platform].filter(stale).length, kind: "stale" as const }
  ]).filter((row) => row.count > 0).sort((a, b) => b.count - a.count);
  return { total: records.length, active: records.length - archived, archived, untitled: records.filter((record) => isUntitled(record.title)).length, byPlatform, insights };
}

function buildTrend(records: StatRecord[], palette: ChartPalette): echarts.EChartsCoreOption {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const firstStart = today.getTime() - 29 * DAY_MS;
  const labels: string[] = [];
  const chatgptSeries: number[] = [];
  const codexSeries: number[] = [];
  for (let offset = 0; offset < 30; offset++) {
    const dayStart = firstStart + offset * DAY_MS;
    const date = new Date(dayStart);
    labels.push(`${date.getMonth() + 1}/${date.getDate()}`);
    chatgptSeries.push(0); codexSeries.push(0);
  }
  for (const record of records) {
    if (record.createdAt === null) continue;
    const day = new Date(record.createdAt); day.setHours(0, 0, 0, 0);
    const offset = Math.round((day.getTime() - firstStart) / DAY_MS);
    if (offset < 0 || offset > 29) continue;
    if (record.platform === "chatgpt") chatgptSeries[offset] = (chatgptSeries[offset] ?? 0) + 1; else codexSeries[offset] = (codexSeries[offset] ?? 0) + 1;
  }
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { data: ["ChatGPT", "Codex"], textStyle: { color: palette.muted }, top: 0 },
    grid: { left: 40, right: 12, top: 32, bottom: 24 },
    xAxis: { type: "category", data: labels, axisLabel: { color: palette.muted, interval: 4 }, axisLine: { lineStyle: { color: palette.border } }, axisTick: { show: false } },
    yAxis: { type: "value", minInterval: 1, axisLabel: { color: palette.muted }, splitLine: { lineStyle: { color: palette.split } } },
    series: [
      { name: "ChatGPT", type: "bar", stack: "new", barMaxWidth: 18, itemStyle: { color: palette.brand }, data: chatgptSeries },
      { name: "Codex", type: "bar", stack: "new", barMaxWidth: 18, itemStyle: { color: palette.warn, borderRadius: [4, 4, 0, 0] }, data: codexSeries }
    ]
  };
}

function buildShare(summary: StatsSummary, palette: ChartPalette): echarts.EChartsCoreOption {
  return {
    tooltip: { trigger: "item" },
    legend: { bottom: 0, textStyle: { color: palette.muted } },
    series: [{
      type: "pie", radius: ["52%", "74%"], center: ["50%", "44%"],
      label: { color: palette.muted, formatter: "{b} {d}%"},
      data: [
        { name: "ChatGPT", value: summary.byPlatform.chatgpt.length, itemStyle: { color: palette.brand } },
        { name: "Codex", value: summary.byPlatform.codex.length, itemStyle: { color: palette.warn } }
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
  return {
    tooltip: {},
    grid: { left: 8, right: 24, top: 8, bottom: 24, containLabel: true },
    xAxis: { type: "value", minInterval: 1, axisLabel: { color: palette.muted }, splitLine: { lineStyle: { color: palette.split } } },
    yAxis: { type: "category", data: rows.map(([id]) => snapshot.projects[id] || id.slice(0, 12)), axisLabel: { color: palette.muted, width: 120, overflow: "truncate" }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.border } } },
    series: [{ type: "bar", barMaxWidth: 16, itemStyle: { color: palette.brand, borderRadius: [0, 8, 8, 0] }, data: rows.map(([, count]) => count) }]
  };
}

export function StatsPage({ onNavigate }: { onNavigate(page: Platform): void }) {
  const dark = useDarkMode();
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(snapshotCache);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(() => {
    setLoading(true);
    void gatherSnapshot().then((next) => { snapshotCache = next; setSnapshot(next); }).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (!snapshotCache) refresh(); }, [refresh]);

  const palette = useMemo(chartPalette, [dark]);
  const summary = useMemo(() => summarize(snapshot?.records ?? []), [snapshot]);
  const trend = useMemo(() => buildTrend(snapshot?.records ?? [], palette), [snapshot, palette]);
  const share = useMemo(() => buildShare(summary, palette), [summary, palette]);
  const projectBars = useMemo(() => snapshot ? buildProjectBars(snapshot, 8, palette) : null, [snapshot, palette]);

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
      <article className="kpi-card"><strong>{summary.total ? `${Math.round((summary.untitled / summary.total) * 100)}%` : "0%"}</strong><span>{t("未命名占比")}</span></article>
    </div>

    <article className="stats-card">
      <h2>{t("近 30 天新增（按平台）")}</h2>
      <Chart option={trend} height={260} />
    </article>

    <div className="stats-row">
      <article className="stats-card">
        <h2>{t("平台占比")}</h2>
        <Chart option={share} height={240} />
      </article>
      <article className="stats-card">
        <h2>{t("项目 Top 8")}</h2>
        {projectBars && <Chart option={projectBars} height={240} />}
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
