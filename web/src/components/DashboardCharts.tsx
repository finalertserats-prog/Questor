import { useEffect, useId, useRef, useState } from 'react';
import { barRadius, niceCeiling, scaleLength, shortDate } from './dashboardModel';

/**
 * Small in-house SVG charts for the dashboard. No chart dependency: three
 * shapes are needed, and each is a few dozen lines. Every chart is an
 * accessible image (role="img" with <title>/<desc>) and also shows its numbers
 * as text, so nothing is conveyed by bar length or colour alone.
 *
 * Each chart measures the column it is sitting in and draws its viewBox at that
 * many user units, so one user unit is one CSS pixel. A fixed viewBox with
 * `width: 100%` looks like it scales only the drawing, but an SVG scales
 * uniformly: on a 1010px column a 480-unit viewBox magnifies everything 2.1x,
 * including the type. That is what turned an 11px axis label into 23px of
 * shouting date and stretched a 220px chart into a screen of whitespace.
 */

/**
 * The rendered width of `ref`, in CSS pixels. Falls back to `fallback` before
 * the first measurement and anywhere ResizeObserver is missing (jsdom in the
 * unit tests), so a chart always has sane geometry to draw with.
 */
function useMeasuredWidth(fallback: number) {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.round(entries[0]?.contentRect.width ?? 0);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/**
 * Pattern definitions, rendered once per chart.
 *
 * The fills below are deliberately not flat washes. A hiring decision is made
 * of evidence that is either there or not, and the chart says so in its own
 * texture: a solid body for what completed, a ruled body for what was only set
 * up. That distinction survives greyscale and a colour-blind reader, because it
 * is carried by line rather than by hue.
 *
 * Defined once per chart and referenced by every bar. A <pattern> instantiated
 * inside the bar loop forces a rasterisation pass per element.
 */
function ChartDefs({ patternId }: { patternId: string }) {
  return (
    <defs>
      <pattern id={patternId} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
        <rect width="5" height="5" className="chart-ruled-ground" />
        {/* crispEdges: at this spacing an anti-aliased diagonal moires against
            the pixel grid on a standard-DPI screen. */}
        <line x1="0" y1="0" x2="0" y2="5" className="chart-ruled-line" shapeRendering="crispEdges" />
      </pattern>
    </defs>
  );
}

export interface WeekPoint {
  readonly weekStart: string;
  readonly created: number;
  readonly completed: number;
}

/** Plot height in CSS pixels, and the gutters around it. */
const COL = { height: 240, left: 34, right: 8, top: 14, bottom: 30 } as const;
const COL_FALLBACK_WIDTH = 900;

/** Grouped columns: interviews set up vs completed, per rolling week. */
export function WeeklyColumnChart({ data }: { data: readonly WeekPoint[] }) {
  const id = useId();
  const { ref, width } = useMeasuredWidth(COL_FALLBACK_WIDTH);
  const patternId = `ruled-${id.replace(/:/g, '')}`;
  const max = niceCeiling(Math.max(0, ...data.flatMap((d) => [d.created, d.completed])));
  const plotW = Math.max(120, width - COL.left - COL.right);
  const plotH = COL.height - COL.top - COL.bottom;
  const slot = data.length ? plotW / data.length : plotW;
  // Bars keep their own proportion of the slot but never grow into slabs on a
  // wide screen: twelve weeks across 1600px would otherwise be 45px wide each.
  const barW = Math.max(3, Math.min(18, slot * 0.28));
  const labelEvery = slot < 60 ? 2 : 1;
  const totals = data.reduce((acc, d) => ({ created: acc.created + d.created, completed: acc.completed + d.completed }), { created: 0, completed: 0 });
  // Quarter steps rather than halves: with a tight ceiling the extra two lines
  // are what let you read a bar's value off the grid instead of guessing.
  const ticks = [0, max / 4, max / 2, (max * 3) / 4, max];

  return (
    <figure className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${width} ${COL.height}`}
        width={width}
        height={COL.height}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        className="chart-svg"
      >
        <ChartDefs patternId={patternId} />
        <title id={`${id}-t`}>Interviews per week, last {data.length} weeks</title>
        <desc id={`${id}-d`}>
          {`${totals.created} interviews set up and ${totals.completed} completed in total. `}
          {data.map((d) => `Week of ${shortDate(d.weekStart)}: ${d.created} set up, ${d.completed} completed.`).join(' ')}
        </desc>
        {/* A ruled baseline with measured ticks rather than a stack of equal
            full-width rules: the axis should read as a scale someone calibrated,
            and the grid should never compete with the data drawn over it. */}
        <line
          x1={COL.left} x2={width - COL.right}
          y1={COL.top + plotH} y2={COL.top + plotH}
          className="chart-baseline" shapeRendering="crispEdges"
        />
        {ticks.map((t, tick) => {
          const y = COL.top + plotH - scaleLength(t, max, plotH);
          return (
            <g key={t}>
              {tick > 0 && (
                <line x1={COL.left} x2={width - COL.right} y1={y} y2={y} className="chart-grid" shapeRendering="crispEdges" />
              )}
              <line x1={COL.left - 4} x2={COL.left} y1={y} y2={y} className="chart-tick" shapeRendering="crispEdges" />
              <text x={COL.left - 8} y={y + 4} textAnchor="end" className="chart-axis">
                {Number.isInteger(t) ? t : t.toFixed(1)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const x = COL.left + i * slot + (slot - barW * 2) / 2;
          const hCreated = scaleLength(d.created, max, plotH);
          const hCompleted = scaleLength(d.completed, max, plotH);
          return (
            <g key={d.weekStart}>
              {/* Set up but not yet finished: a ruled body. Finished: solid.
                  The pair reads as work in hand against work banked, even with
                  the colour taken out. The ruled body carries its own edge or it
                  dissolves at one or two units. */}
              <rect
                x={x} y={COL.top + plotH - hCreated} width={barW} height={hCreated}
                rx={barRadius(barW, hCreated)} ry={barRadius(barW, hCreated)}
                fill={`url(#${patternId})`}
                className="chart-rise"
              />
              <rect
                x={x} y={COL.top + plotH - hCreated} width={barW} height={hCreated}
                rx={barRadius(barW, hCreated)} ry={barRadius(barW, hCreated)}
                className="chart-series-a-edge chart-rise"
              />
              <rect
                x={x + barW} y={COL.top + plotH - hCompleted} width={barW} height={hCompleted}
                rx={barRadius(barW, hCompleted)} ry={barRadius(barW, hCompleted)}
                className="chart-series-b chart-rise"
              />
              {/* A week nobody worked is not the same as a week off the end of
                  the chart. Say so with a witness mark rather than nothing. */}
              {d.created === 0 && d.completed === 0 && (
                <line
                  x1={x} x2={x + barW * 2}
                  y1={COL.top + plotH} y2={COL.top + plotH}
                  className="chart-witness" shapeRendering="crispEdges"
                />
              )}
              {i % labelEvery === (data.length - 1) % labelEvery && (
                <text x={COL.left + i * slot + slot / 2} y={COL.height - 10} textAnchor="middle" className="chart-axis">
                  {shortDate(d.weekStart)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="chart-legend">
        <span><i className="swatch chart-series-a" aria-hidden="true" />Set up <strong>{totals.created}</strong></span>
        <span><i className="swatch chart-series-b" aria-hidden="true" />Completed <strong>{totals.completed}</strong></span>
      </figcaption>
      <details className="chart-data">
        <summary>Show data</summary>
        <table>
          <thead><tr><th>Week of</th><th>Set up</th><th>Completed</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.weekStart}><td>{shortDate(d.weekStart)}</td><td>{d.created}</td><td>{d.completed}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export interface BarItem {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** CSS modifier for the bar's fill, e.g. 'tone-pass'. */
  readonly tone?: string;
}

const ROW_H = 30;
const BAR = { labelW: 120, valueW: 40 } as const;
const BAR_FALLBACK_WIDTH = 480;

/** Horizontal bars with the label and value printed on each row. */
export function HorizontalBarChart({ items, title, summary }: { items: readonly BarItem[]; title: string; summary: string }) {
  const id = useId();
  const { ref, width } = useMeasuredWidth(BAR_FALLBACK_WIDTH);
  const patternId = `ruled-${id.replace(/:/g, '')}`;
  const max = niceCeiling(Math.max(0, ...items.map((i) => i.count)));
  const plotW = Math.max(60, width - BAR.labelW - BAR.valueW);
  const height = Math.max(ROW_H, items.length * ROW_H);

  return (
    <figure className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        className="chart-svg"
      >
        <ChartDefs patternId={patternId} />
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{`${summary} ${items.map((i) => `${i.label}: ${i.count}.`).join(' ')}`}</desc>
        {items.map((item, index) => {
          const y = index * ROW_H;
          const w = scaleLength(item.count, max, plotW);
          return (
            <g key={item.key}>
              <text x={BAR.labelW - 10} y={y + ROW_H / 2 + 4} textAnchor="end" className="chart-label">{item.label}</text>
              {/* A ruled channel, not a grey capsule. The track is the measure
                  the bar is read against, so it should look like a rule rather
                  than a second bar sitting behind the first. */}
              <line
                x1={BAR.labelW} x2={BAR.labelW + plotW}
                y1={y + ROW_H / 2} y2={y + ROW_H / 2}
                className="chart-channel" shapeRendering="crispEdges"
              />
              <line
                x1={BAR.labelW + plotW} x2={BAR.labelW + plotW}
                y1={y + 8} y2={y + ROW_H - 8}
                className="chart-tick" shapeRendering="crispEdges"
              />
              <rect
                x={BAR.labelW} y={y + 7} width={w} height={ROW_H - 14}
                rx={barRadius(w, ROW_H - 14)} ry={barRadius(w, ROW_H - 14)}
                className={`chart-bar chart-grow ${item.tone ?? 'tone-accent'}`}
              />
              {item.count === 0 && (
                <line
                  x1={BAR.labelW} x2={BAR.labelW}
                  y1={y + 8} y2={y + ROW_H - 8}
                  className="chart-witness" shapeRendering="crispEdges"
                />
              )}
              <text x={BAR.labelW + w + 6} y={y + ROW_H / 2 + 4} className="chart-value">{item.count}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
