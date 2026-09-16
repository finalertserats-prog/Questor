import { useId } from 'react';
import { barRadius, niceCeiling, scaleLength, shortDate } from './dashboardModel';

/**
 * Small in-house SVG charts for the dashboard. No chart dependency: three
 * shapes are needed, and each is a few dozen lines. Every chart is an
 * accessible image (role="img" with <title>/<desc>) and also shows its numbers
 * as text, so nothing is conveyed by bar length or colour alone.
 */

export interface WeekPoint {
  readonly weekStart: string;
  readonly created: number;
  readonly completed: number;
}

const COL = { width: 480, height: 220, left: 30, right: 8, top: 12, bottom: 28 } as const;

/** Grouped columns: interviews set up vs completed, per rolling week. */
export function WeeklyColumnChart({ data }: { data: readonly WeekPoint[] }) {
  const id = useId();
  const max = niceCeiling(Math.max(0, ...data.flatMap((d) => [d.created, d.completed])));
  const plotW = COL.width - COL.left - COL.right;
  const plotH = COL.height - COL.top - COL.bottom;
  const slot = data.length ? plotW / data.length : plotW;
  const barW = Math.max(2, slot * 0.34);
  const labelEvery = data.length > 8 ? 2 : 1;
  const totals = data.reduce((acc, d) => ({ created: acc.created + d.created, completed: acc.completed + d.completed }), { created: 0, completed: 0 });
  const ticks = [0, max / 2, max];

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${COL.width} ${COL.height}`}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        className="chart-svg"
      >
        <title id={`${id}-t`}>Interviews per week, last {data.length} weeks</title>
        <desc id={`${id}-d`}>
          {`${totals.created} interviews set up and ${totals.completed} completed in total. `}
          {data.map((d) => `Week of ${shortDate(d.weekStart)}: ${d.created} set up, ${d.completed} completed.`).join(' ')}
        </desc>
        {ticks.map((t) => {
          const y = COL.top + plotH - scaleLength(t, max, plotH);
          return (
            <g key={t}>
              <line x1={COL.left} x2={COL.width - COL.right} y1={y} y2={y} className="chart-grid" />
              <text x={COL.left - 6} y={y + 4} textAnchor="end" className="chart-axis">{Number.isInteger(t) ? t : t.toFixed(1)}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const x = COL.left + i * slot + (slot - barW * 2) / 2;
          const hCreated = scaleLength(d.created, max, plotH);
          const hCompleted = scaleLength(d.completed, max, plotH);
          return (
            <g key={d.weekStart}>
              <rect
                x={x} y={COL.top + plotH - hCreated} width={barW} height={hCreated}
                rx={barRadius(barW, hCreated)} ry={barRadius(barW, hCreated)}
                className="chart-series-a chart-rise"
              />
              <rect
                x={x + barW} y={COL.top + plotH - hCompleted} width={barW} height={hCompleted}
                rx={barRadius(barW, hCompleted)} ry={barRadius(barW, hCompleted)}
                className="chart-series-b chart-rise"
              />
              {i % labelEvery === (data.length - 1) % labelEvery && (
                <text x={COL.left + i * slot + slot / 2} y={COL.height - 8} textAnchor="middle" className="chart-axis">
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
const BAR = { width: 480, labelW: 120, valueW: 40 } as const;

/** Horizontal bars with the label and value printed on each row. */
export function HorizontalBarChart({ items, title, summary }: { items: readonly BarItem[]; title: string; summary: string }) {
  const id = useId();
  const max = niceCeiling(Math.max(0, ...items.map((i) => i.count)));
  const plotW = BAR.width - BAR.labelW - BAR.valueW;
  const height = Math.max(ROW_H, items.length * ROW_H);

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${BAR.width} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="chart-svg">
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{`${summary} ${items.map((i) => `${i.label}: ${i.count}.`).join(' ')}`}</desc>
        {items.map((item, index) => {
          const y = index * ROW_H;
          const w = scaleLength(item.count, max, plotW);
          return (
            <g key={item.key}>
              <text x={BAR.labelW - 10} y={y + ROW_H / 2 + 4} textAnchor="end" className="chart-label">{item.label}</text>
              <rect
                x={BAR.labelW} y={y + 7} width={plotW} height={ROW_H - 14}
                rx={barRadius(plotW, ROW_H - 14)} ry={barRadius(plotW, ROW_H - 14)}
                className="chart-track"
              />
              <rect
                x={BAR.labelW} y={y + 7} width={w} height={ROW_H - 14}
                rx={barRadius(w, ROW_H - 14)} ry={barRadius(w, ROW_H - 14)}
                className={`chart-bar chart-grow ${item.tone ?? 'tone-accent'}`}
              />
              <text x={BAR.labelW + w + 6} y={y + ROW_H / 2 + 4} className="chart-value">{item.count}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
