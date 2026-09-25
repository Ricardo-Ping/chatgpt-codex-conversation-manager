import { useEffect, useRef } from "react";
import { echarts } from "./echarts.js";

/** ECharts 挂载的公共组件：init / ResizeObserver 自适应 / option 变化全量重画 */
export function Chart({ option, height }: { option: echarts.EChartsCoreOption; height: number }) {
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
