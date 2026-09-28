import { useId, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMeasuredWidth } from './useMeasuredWidth';
import {
  axisLabelStride,
  BAR_LAYOUT,
  BAR_ROW,
  barRadius,
  chooseBarLayout,
  clampLabelCenter,
  countAxis,
  estimateTextWidth,
  niceCeiling,
  scaleLength,
  shortDate,
  type MeasureText,
} from './dashboardModel';

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

let measureCanvas: HTMLCanvasElement | null = null;

/**
 * A text measurer for the chart face named by `fontVar` at `size` px. Uses the
 * canvas's measureText where there is a document, and a per-character estimate
 * everywhere else, so layout never depends on a DOM being present.
 */
function textMeasurer(fontVar: string, size: number, weight = 400): MeasureText {
  const estimate: MeasureText = (text) => estimateTextWidth(text, size);
  if (typeof document === 'undefined') return estimate;
  try {
    measureCanvas ??= document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    if (!ctx) return estimate;
    const family = getComputedStyle(document.documentElement).getPropertyValue(fontVar).trim() || 'sans-serif';
    const font = `${weight} ${size}px ${family}`;
    return (text) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
  } catch {
    return estimate;
  }
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
  // Interviews come in whole numbers, so the axis does too: one line per
  // integer step, never quarter-splits of a ceiling.
  const { max, ticks } = countAxis(Math.max(0, ...data.flatMap((d) => [d.created, d.completed])));
  const plotW = Math.max(120, width - COL.left - COL.right);
  const plotH = COL.height - COL.top - COL.bottom;
  const slot = data.length ? plotW / data.length : plotW;
  // Bars keep their own proportion of the slot but never grow into slabs on a
  // wide screen: twelve weeks across 1600px would otherwise be 45px wide each.
  // Floor of 6, not 3: the ruled fill repeats every 5px, so a 3px bar holds
  // barely one stripe and reads as a solid tone rather than as ruled.
  const barW = Math.max(6, Math.min(18, slot * 0.28));
  const weekLabels = data.map((d) => shortDate(d.weekStart));
  const measureAxis = useMemo(() => textMeasurer('--font-data', 11), []);
  const widestLabel = Math.max(0, ...weekLabels.map(measureAxis));
  const labelEvery = axisLabelStride(slot, widestLabel);
  const totals = data.reduce((acc, d) => ({ created: acc.created + d.created, completed: acc.completed + d.completed }), { created: 0, completed: 0 });

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
                {t}
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
                <text
                  x={clampLabelCenter(COL.left + i * slot + slot / 2, measureAxis(weekLabels[i]), width)}
                  y={COL.height - 10} textAnchor="middle" className="chart-axis"
                >
                  {weekLabels[i]}
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
  /** In-app route the row opens, e.g. /roles/:id. */
  readonly to?: string;
}

const BAR_FALLBACK_WIDTH = 480;
const BAR_THICKNESS = 16;

/**
 * Horizontal bars with the label and value printed on each row.
 *
 * Labels sit beside the bars when they all fit; otherwise each label takes its
 * own full-width line above its bar (chooseBarLayout). A row with a route is a
 * link, so the chart is a way into the thing it counts.
 */
export function HorizontalBarChart({ items, title, summary }: { items: readonly BarItem[]; title: string; summary: string }) {
  const id = useId();
  const navigate = useNavigate();
  const { ref, width } = useMeasuredWidth(BAR_FALLBACK_WIDTH);
  const max = niceCeiling(Math.max(0, ...items.map((i) => i.count)));
  const measureLabel = useMemo(() => textMeasurer('--font-ui', 12.5), []);
  const measureValue = useMemo(() => textMeasurer('--font-data', 11, 600), []);
  const layout = chooseBarLayout(items.map((i) => i.label), items.map((i) => i.count), width, measureLabel, measureValue);
  const { labelW, plotW, rowHeight, labelLines, rowTops, height } = layout;
  const stacked = layout.mode === 'stacked';
  const linked = items.some((i) => i.to);

  return (
    <figure className={`chart chart-bars chart-bars--${layout.mode}`} ref={ref}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        // With links inside, the chart is a group of rows a keyboard can reach;
        // an img would hide them from assistive technology.
        role={linked ? 'group' : 'img'}
        aria-labelledby={`${id}-t ${id}-d`}
        className="chart-svg"
      >
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{`${summary} ${items.map((i) => `${i.label}: ${i.count}.`).join(' ')}`}</desc>
        {items.map((item, index) => {
          const top = rowTops[index];
          const lines = labelLines[index];
          const labelBlock = stacked ? lines.length * BAR_ROW.stackedLabel : 0;
          const thisRow = stacked ? labelBlock + BAR_ROW.stackedBar : rowHeight;
          const barTop = stacked ? top + labelBlock + (BAR_ROW.stackedBar - BAR_THICKNESS) / 2 : top + (rowHeight - BAR_THICKNESS) / 2;
          const barMid = barTop + BAR_THICKNESS / 2;
          const w = scaleLength(item.count, max, plotW);
          const row = (
            <>
              {/* Catches the pointer across the whole row and carries the focus ring. */}
              <rect x={1} y={top + 1} width={Math.max(0, width - 2)} height={thisRow - 2} rx={4} className="chart-row-hit" />
              <text
                x={stacked ? 0 : labelW - 10}
                y={stacked ? top + 13 : barMid + 4}
                textAnchor={stacked ? 'start' : 'end'}
                className="chart-label"
              >
                <title>{item.label}</title>
                {lines.map((line, n) => (
                  <tspan key={n} x={stacked ? 0 : labelW - 10} dy={n === 0 ? 0 : BAR_ROW.stackedLabel}>{line}</tspan>
                ))}
              </text>
              {/* No channel behind the bar. A full-width track is what makes a
                  bar chart read as a progress meter. The end tick marks where
                  the scale finishes; every row prints its own number. */}
              <line
                x1={labelW + plotW} x2={labelW + plotW}
                y1={barTop + 1} y2={barTop + BAR_THICKNESS - 1}
                className="chart-tick" shapeRendering="crispEdges"
              />
              <rect
                x={labelW} y={barTop} width={w} height={BAR_THICKNESS}
                rx={barRadius(w, BAR_THICKNESS)} ry={barRadius(w, BAR_THICKNESS)}
                className={`chart-bar chart-grow ${item.tone ?? 'tone-accent'}`}
              />
              {item.count === 0 && (
                <line
                  x1={labelW} x2={labelW}
                  y1={barTop + 1} y2={barTop + BAR_THICKNESS - 1}
                  className="chart-witness" shapeRendering="crispEdges"
                />
              )}
              <text x={labelW + w + BAR_LAYOUT.valueGap} y={barMid + 4} className="chart-value">{item.count}</text>
            </>
          );
          const to = item.to;
          return to ? (
            <a
              key={item.key}
              href={to}
              className="chart-row-link"
              aria-label={`${item.label}: ${item.count}`}
              onClick={(event) => { event.preventDefault(); navigate(to); }}
            >
              {row}
            </a>
          ) : <g key={item.key}>{row}</g>;
        })}
      </svg>
    </figure>
  );
}
