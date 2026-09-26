import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { chartTooltip, echarts, type ChartPalette } from "./echarts.js";
import { relativeTime } from "./conversation-viewer.js";
import { Chart } from "./chart.js";
import { Segmented } from "./segmented.js";
import { buildUsageView, formatRequests, formatTokens, formatUsd, instanceName, sharePercent, USAGE_RANGES, type UsageRange } from "./codex-usage-model.js";
import { rendererLanguage, t } from "./strings.js";
import type { CodexUsageSummary } from "./global.d.js";

/** 统计页的「Codex 会话用量」卡片：数据来自主进程对本机 Codex 会话日志的
 * 增量扫描（stats:codex-usage），这里只做筛选、绘图与展示。 */

type UsageMetric = "tokens" | "requests";
const METRICS: Array<[UsageMetric, string]> = [["tokens", "合计 Tokens"], ["requests", "请求数"]];

function shortDate(key: string): string {
  const [, month, day] = key.split("-");
  return `${Number(month)}/${Number(day)}`;
}

const Icon = {
  input: (
    <svg viewBox="0 0 16 16" aria-hidden><path d="M8 2v8m0 0 3.2-3.2M8 10 4.8 6.8M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
  cached: (
    <svg viewBox="0 0 16 16" aria-hidden><ellipse cx="8" cy="4" rx="5" ry="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M3 4v8c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M3 8c0 1.2 2.2 2.2 5 2.2S13 9.2 13 8" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
  ),
  output: (
    <svg viewBox="0 0 16 16" aria-hidden><path d="M8 14V6m0 0 3.2 3.2M8 6 4.8 9.2M3 3h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
  total: (
    <svg viewBox="0 0 16 16" aria-hidden><path d="M3.5 2.5h9L8 8l4.5 5.5h-9L8 8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
  ),
  requests: (
    <svg viewBox="0 0 16 16" aria-hidden><path d="M14 2 7.3 8.7M14 2 9.7 14l-2.4-5.3L2 6.3 14 2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
  ),
  cost: (
    <svg viewBox="0 0 16 16" aria-hidden><path d="M8 1.5v13M11 4.2c-.6-1-1.7-1.4-3-1.4-1.6 0-2.9.9-2.9 2.3 0 3 5.9 1.6 5.9 4.7 0 1.5-1.4 2.4-3 2.4-1.5 0-2.7-.6-3.3-1.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  )
};

function buildUsageChart(view: ReturnType<typeof buildUsageView>, metric: UsageMetric, palette: ChartPalette): echarts.EChartsCoreOption {
  const lang = rendererLanguage();
  const labels = view.series.map((day) => shortDate(day.date));
  const data = view.series.map((day) => (metric === "tokens" ? day.totalTokens : day.requests));
  const color = metric === "tokens" ? palette.codex : palette.brand;
  const average = data.length ? data.reduce((sum, value) => sum + value, 0) / data.length : 0;
  const axisLabel = metric === "tokens"
    ? (value: number) => formatTokens(value, lang)
    : (value: number) => formatRequests(value);
  const averageLabel = metric === "tokens" ? `${t("日均")} ${formatTokens(average, lang)}` : `${t("日均")} ${formatRequests(average)}`;
  return {
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: palette.border } },
      formatter: (params: Array<{ dataIndex?: number }>) => {
        const day = view.series[params[0]?.dataIndex ?? -1];
        if (!day) return "";
        return `<b>${day.date}</b><br/>${t("合计 Tokens")}：${formatTokens(day.totalTokens, lang)} <span style="opacity:.6">(${formatRequests(day.totalTokens)})</span><br/>${t("请求数")}：${formatRequests(day.requests)}<br/>${t("估算费用")}：${formatUsd(day.costUsd)}`;
      },
      ...chartTooltip(palette)
    },
    grid: { left: 52, right: 20, top: 32, bottom: 26 },
    xAxis: { type: "category", data: labels, boundaryGap: false, axisLabel: { color: palette.muted }, axisLine: { lineStyle: { color: palette.border } }, axisTick: { show: false } },
    yAxis: { type: "value", minInterval: metric === "requests" ? 1 : 0, axisLabel: { color: palette.muted, formatter: axisLabel }, splitLine: { lineStyle: { color: palette.split } } },
    series: [{
      type: "line",
      data,
      smooth: 0.35,
      symbol: "circle",
      symbolSize: 6,
      showSymbol: view.series.length <= 31,
      lineStyle: { width: 2.5, color },
      itemStyle: { color, borderColor: palette.surface, borderWidth: 2 },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color }, { offset: 1, color }]
        },
        opacity: 0.12,
        origin: "start"
      },
      markLine: data.length > 1 ? {
        silent: true,
        symbol: "none",
        lineStyle: { color: palette.muted, type: "dashed", width: 1 },
        label: { color: palette.muted, formatter: averageLabel, position: "insideStartTop" },
        data: [{ yAxis: average }]
      } : undefined
    }]
  };
}

function UsageTile({ icon, tone, label, value, title }: { icon: ReactNode; tone: string; label: string; value: string; title?: string }) {
  return <div className="usage-tile" title={title}>
    <span className="usage-tile-icon" style={{ color: tone, background: `color-mix(in srgb, ${tone} 13%, transparent)` }} aria-hidden>{icon}</span>
    <div className="usage-tile-body">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  </div>;
}

interface UsageTableRow { name: string; fullName: string; cells: string[]; total: string; totalTitle: string; share: number }

function UsageTable({ label, nameColumn, cellColumns, rows, wrapClass, count }: { label: string; nameColumn: string; cellColumns: string[]; rows: UsageTableRow[]; wrapClass?: string; count?: number }) {
  return <div className={`usage-table-wrap${wrapClass ? ` ${wrapClass}` : ""}`}>
    <h3>{label}{typeof count === "number" && count > 0 && <span className="usage-count">{formatRequests(count)}</span>}</h3>
    <div className="usage-table-body">
      <table className="usage-table">
        <thead><tr>
          <th className="usage-name">{nameColumn}</th>
          {cellColumns.map((column) => <th key={column} className="usage-num">{column}</th>)}
          <th className="usage-num">{t("合计")}</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.fullName}>
            <td className="usage-name" title={row.fullName !== row.name ? row.fullName : undefined}>{row.name}</td>
            {row.cells.map((cell, index) => <td key={index} className="usage-num">{cell}</td>)}
            <td className="usage-num usage-total" title={row.totalTitle}>
              <span>{row.total}</span>
              <i aria-hidden><b style={{ width: `${row.share}%` }} /></i>
            </td>
          </tr>)}
        </tbody>
      </table>
      {!rows.length && <p className="usage-table-empty">{t("暂无数据")}</p>}
    </div>
  </div>;
}

export function CodexUsageCard({ palette, refreshSignal }: { palette: ChartPalette; refreshSignal: number }) {
  const lang = rendererLanguage();
  const [summary, setSummary] = useState<CodexUsageSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<UsageRange>("7");
  const [instance, setInstance] = useState("all");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const supported = typeof window.conversationManager.stats?.codexUsage === "function";

  const load = useCallback((force: boolean) => {
    if (typeof window.conversationManager.stats?.codexUsage !== "function") return;
    setBusy(true);
    window.conversationManager.stats.codexUsage({ force })
      .then((next) => setSummary(next))
      .catch(() => {})
      .finally(() => setBusy(false));
  }, []);
  // refreshSignal 从 0 开始：首次挂载和「刷新统计」都走这里
  useEffect(() => { if (supported) load(false); }, [supported, load, refreshSignal]);

  const view = useMemo(() => buildUsageView(summary, range, instance), [summary, range, instance]);
  const chart = useMemo(() => buildUsageChart(view, metric, palette), [view, metric, palette]);
  const maxModelTotal = view.models[0]?.totalTokens ?? 0;
  const maxInstanceTotal = view.instances[0]?.totalTokens ?? 0;
  const maxDayTotal = view.dayRows.reduce((max, row) => Math.max(max, row.totalTokens), 0);

  if (!supported) return null;

  const statusLine = summary
    ? summary.scannedFiles > 0
      ? t("已扫描 {files} 个文件 · {sessions} 个会话 · 累计 {requests} 次请求 · 最近扫描 {time}", {
        files: formatRequests(summary.scannedFiles),
        sessions: formatRequests(summary.sessions),
        requests: formatRequests(summary.requests),
        time: relativeTime(summary.generatedAt)
      }) + (summary.forkedSessions > 0 ? ` · ${t("分叉会话 {n} 个", { n: summary.forkedSessions })}` : "")
      : t("未在本机找到 Codex 会话日志")
    : t("正在扫描本机会话日志…");

  const instanceOptions = [
    { value: "all", label: t("全部实例"), title: undefined as string | undefined },
    ...(summary?.instances ?? []).map((row) => ({ value: row.cwd, label: instanceName(row.cwd) || t("未知"), title: row.cwd || undefined }))
  ];
  const hasAnything = Boolean(summary && summary.scannedFiles > 0);
  const hasInRange = view.series.length > 0;

  return <article className={`stats-card usage-card`}>
    <h2>{t("Codex 会话用量")}
      <span className="head-extra">
        <Segmented<UsageRange> value={range} options={USAGE_RANGES.map(([value, label]) => [value, t(label)] as [UsageRange, string])} onChange={setRange} aria-label={t("时间范围")} />
        {hasAnything && <>
          <Segmented<UsageMetric> value={metric} options={METRICS.map(([value, label]) => [value, t(label)] as [UsageMetric, string])} onChange={setMetric} aria-label={t("图表指标")} />
          <select className="usage-instance" value={instance} onChange={(event) => setInstance(event.target.value)} aria-label={t("按实例筛选")}>
            {instanceOptions.map((option) => <option key={option.value} value={option.value} title={option.title}>{option.label}</option>)}
          </select>
        </>}
        <button type="button" className="usage-rescan" disabled={busy} onClick={() => load(true)} title={t("重新解析全部会话日志（忽略缓存）")}>{busy ? t("扫描中…") : t("重新扫描")}</button>
      </span>
    </h2>
    <p className="usage-sub">
      {t("从本机 Codex 会话日志（JSONL）汇总真实 Token 用量，不依赖官方配额或 API 服务日志。")}
      <span className="usage-status">{statusLine}</span>
    </p>

    {hasAnything && hasInRange && <>
      <div className="usage-tiles">
        <UsageTile icon={Icon.input} tone={palette.codex} label={t("输入 Tokens")} value={formatTokens(view.totals.input, lang)} title={formatRequests(view.totals.input)} />
        <UsageTile icon={Icon.cached} tone={palette.brand} label={t("缓存输入 Tokens")} value={formatTokens(view.totals.cachedInput, lang)} title={formatRequests(view.totals.cachedInput)} />
        <UsageTile icon={Icon.output} tone={palette.ok} label={t("输出 Tokens")} value={formatTokens(view.totals.output, lang)} title={formatRequests(view.totals.output)} />
        <UsageTile icon={Icon.total} tone={palette.text} label={t("合计 Tokens")} value={formatTokens(view.totals.totalTokens, lang)} title={formatRequests(view.totals.totalTokens)} />
        <UsageTile icon={Icon.requests} tone={palette.warn} label={t("请求数")} value={formatRequests(view.totals.requests)} />
        <UsageTile icon={Icon.cost} tone={palette.chat} label={t("估算费用")} value={formatUsd(view.totals.costUsd)} title={t("费用按公开 API 价格估算，仅作参考。")} />
      </div>
      <div className="usage-chart">
        <Chart option={chart} height={264} />
      </div>
      <div className="stats-row usage-tables">
        <UsageTable
          label={t("按模型")}
          wrapClass="scroll models"
          count={view.models.length}
          nameColumn={t("模型")}
          cellColumns={[t("输入"), t("缓存"), t("输出"), t("请求"), t("费用")]}
          rows={view.models.map((row) => ({
            name: row.name,
            fullName: row.fullName,
            cells: [formatTokens(row.input, lang), formatTokens(row.cachedInput, lang), formatTokens(row.output, lang), formatRequests(row.requests), formatUsd(row.costUsd)],
            total: formatTokens(row.totalTokens, lang),
            totalTitle: formatRequests(row.totalTokens),
            share: sharePercent(row.totalTokens, maxModelTotal)
          }))}
        />
        <UsageTable
          label={t("按实例")}
          wrapClass="scroll"
          count={view.instances.length}
          nameColumn={t("实例")}
          cellColumns={[t("输入"), t("缓存"), t("输出"), t("请求")]}
          rows={view.instances.map((row) => ({
            name: row.name || t("未知"),
            fullName: row.fullName,
            cells: [formatTokens(row.input, lang), formatTokens(row.cachedInput, lang), formatTokens(row.output, lang), formatRequests(row.requests)],
            total: formatTokens(row.totalTokens, lang),
            totalTitle: formatRequests(row.totalTokens),
            share: sharePercent(row.totalTokens, maxInstanceTotal)
          }))}
        />
      </div>
      <UsageTable
        label={t("按日期")}
        wrapClass="scroll"
        count={view.dayRows.length}
        nameColumn={t("日期")}
        cellColumns={[t("输入"), t("缓存"), t("输出"), t("请求"), t("费用")]}
        rows={view.dayRows.map((row) => ({
          name: row.date,
          fullName: row.date,
          cells: [formatTokens(row.input, lang), formatTokens(row.cachedInput, lang), formatTokens(row.output, lang), formatRequests(row.requests), formatUsd(row.costUsd)],
          total: formatTokens(row.totalTokens, lang),
          totalTitle: formatRequests(row.totalTokens),
          share: sharePercent(row.totalTokens, maxDayTotal)
        }))}
      />
    </>}

    {hasAnything && !hasInRange && <div className="chart-empty">
      <strong>{t("该范围内暂无用量")}</strong>
      <span>{t("换个时间范围或实例再试试。")}</span>
    </div>}
    {!hasAnything && <div className="chart-empty">
      <strong>{t("暂无用量数据")}</strong>
      <span>{t("启动 Codex 并完成至少一次对话后，这里会展示真实的 Token 用量统计。")}</span>
    </div>}
  </article>;
}
