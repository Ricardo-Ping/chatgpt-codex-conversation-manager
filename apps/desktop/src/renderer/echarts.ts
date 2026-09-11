// ECharts 按需注册：只引入统计页用到的图表/组件与 Canvas 渲染器，控制打包体积。
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export interface ChartPalette {
  text: string;
  muted: string;
  split: string;
  border: string;
  brand: string;
  brandSoft: string;
  warn: string;
  ok: string;
  off: string;
}

// 图表配色直接读取应用的 CSS 变量，与全局浅色/深色主题保持一致；
// 主题切换（含 nativeTheme 三态引起的媒体查询变化）后重新读取并 setOption 即可。
export function chartPalette(): ChartPalette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string => css.getPropertyValue(name).trim() || "#888";
  return {
    text: v("--text-strong"),
    muted: v("--text-muted"),
    split: v("--border-soft"),
    border: v("--border"),
    brand: v("--brand"),
    brandSoft: v("--brand-soft"),
    warn: v("--warn"),
    ok: v("--ok"),
    off: v("--off")
  };
}

export { echarts };
