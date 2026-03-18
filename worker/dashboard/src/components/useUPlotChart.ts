import { useRef, useEffect } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export function useUPlotChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  getOpts: () => Omit<uPlot.Options, "width">,
  data: uPlot.AlignedData | null,
) {
  const chartRef = useRef<uPlot | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const getOptsRef = useRef(getOpts);
  getOptsRef.current = getOpts;

  // Cleanup on unmount only
  useEffect(() => () => {
    observerRef.current?.disconnect();
    chartRef.current?.destroy();
    chartRef.current = null;
  }, []);

  // Create or update chart
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data || data[0].length === 0) return;

    if (chartRef.current) {
      chartRef.current.setData(data);
      return;
    }

    const opts = { ...getOptsRef.current(), width: el.clientWidth };
    chartRef.current = new uPlot(opts, data, el);

    const observer = new ResizeObserver(() => {
      if (chartRef.current) {
        chartRef.current.setSize({ width: el.clientWidth, height: opts.height });
      }
    });
    observer.observe(el);
    observerRef.current = observer;
  }, [data, containerRef]);
}
