import { useId } from 'react';
import { barRadius, estimateTextWidth, niceCeiling, scaleLength } from '../dashboardModel';
import { useMeasuredWidth } from '../useMeasuredWidth';
import type { CountColumn, RateBar } from './outcomeModel';

/**
 * The outcome panel's charts. Hand-drawn SVG, like the dashboard's, and for the
 * same reasons: two shapes are needed, each is a few dozen lines, and every
 * chart has to print its own numbers as text so nothing is carried by bar
 * length or colour alone.
 *
 * COLOUR. One hue per chart — the charts here compare magnitudes, which is a
 * sequential job, not an identity one. That also sidesteps the one gate the
 * app's chart palette does not clear: --chart-a and --chart-b sit 13.0 apart in
 * dark mode, below the 15 a full-colour reader needs to tell two series apart.
 * Nothing on this page puts those two beside each other.
 *
 * TOO FEW TO READ. A bar whose sample is below the minimum is drawn with the
 * ruled fill rather than a solid one, and prints the reason beside it. The
 * distinction is carried by LINE, not hue, so it survives greyscale, colour
 * blindness and a printout — which is the whole point of marking it.
 */

/** The ruled fill, defined once per chart. A <pattern> inside a loop rasterises per element. */
function ChartDefs({ patternId }: { patternId: string }) {
  return (
    <defs>
      <pattern id={patternId} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
        <rect width="5" height="5" className="chart-ruled-ground" />
        {/* crispEdges: at this spacing an anti-aliased diagonal moirés against the pixel grid. */}
        <line x1="0" y1="0" x2="0" y2="5" className="chart-ruled-line" shapeRendering="crispEdges" />
      </pattern>
    </defs>
  );
}

const BAR = { thickness: 16, row: 34, stackedLabel: 17, stackedRow: 40, gap: 8, right: 8 } as const;
const BAR_FALLBACK_WIDTH = 640;
/** Labels sit beside the bars only while they leave the plot most of the column. */
const LABEL_SHARE = 0.36;

export interface RateBarChartProps {
  readonly bars: readonly RateBar[];
  readonly title: string;
  /** The sentence a screen reader hears before the numbers. */
  readonly summary: string;
  /** Column header for the value in the table view, e.g. 'Rate'. */
  readonly valueHeading: string;
  /**
   * Leave out the chart's own table. Only for a chart a fuller table of the
   * same numbers follows immediately — two tables of one thing, one after the
   * other, is noise, and the numbers are still in text either way.
   */
  readonly tableless?: boolean;
}

/**
 * Horizontal bars for a proportion. The scale is always the full 0-100%, so
 * two cuts read against the same ruler; a bar that fills the row means
 * everyone, not "the most of these groups".
 */
export function RateBarChart({ bars, title, summary, valueHeading, tableless }: RateBarChartProps) {
  const id = useId();
  const patternId = `ruled-${id.replace(/:/g, '')}`;
  const { ref, width } = useMeasuredWidth(BAR_FALLBACK_WIDTH);

  const labelWidths = bars.map((bar) => estimateTextWidth(bar.label, 12.5));
  // Measured at 13 though it is set at 11: the value is in the monospace data
  // face, whose every character is wider than estimateTextWidth's average for
  // the proportional UI face. Reserving from the proportional estimate clipped
  // the longest row's sample off the right edge — the part that must not be
  // lost. Over-reserving only leaves a little air.
  const valueWidths = bars.map((bar) => estimateTextWidth(`[${bar.percent}] · ${bar.counts}`, 13));
  const widest = Math.max(0, ...labelWidths);
  const stacked = widest > width * LABEL_SHARE;
  const labelW = stacked ? 0 : Math.ceil(widest) + BAR.gap * 2;
  const valueW = Math.ceil(Math.max(0, ...valueWidths)) + BAR.gap * 2;
  const plotW = Math.max(40, width - labelW - valueW - BAR.right);
  const rowHeight = stacked ? BAR.stackedRow : BAR.row;
  const height = Math.max(rowHeight, bars.length * rowHeight);

  return (
    <div className="report-chart">
      <figure className="chart chart-bars" ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-labelledby={`${id}-t ${id}-d`}
          className="chart-svg"
        >
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>
            {`${summary} ${bars.map((b) => `${b.label}: ${b.percent || b.counts}${b.readable ? '' : ' (too few to read)'}.`).join(' ')}`}
          </desc>
          <ChartDefs patternId={patternId} />
          {bars.map((bar, index) => {
            const top = index * rowHeight;
            const barTop = stacked ? top + BAR.stackedLabel + 2 : top + (rowHeight - BAR.thickness) / 2;
            const mid = barTop + BAR.thickness / 2;
            const w = scaleLength(bar.value, 1, plotW);
            return (
              <g key={bar.key}>
                <text
                  x={stacked ? 0 : labelW - BAR.gap}
                  y={stacked ? top + 13 : mid + 4}
                  textAnchor={stacked ? 'start' : 'end'}
                  className="chart-label"
                >
                  {bar.label}
                </text>
                {/* Where the scale finishes. No track behind the bar: a
                    full-width channel makes a bar chart read as a progress meter. */}
                <line
                  x1={labelW + plotW} x2={labelW + plotW}
                  y1={barTop + 1} y2={barTop + BAR.thickness - 1}
                  className="chart-tick" shapeRendering="crispEdges"
                />
                <rect
                  x={labelW} y={barTop} width={w} height={BAR.thickness}
                  rx={barRadius(w, BAR.thickness)} ry={barRadius(w, BAR.thickness)}
                  className={bar.readable ? 'chart-bar report-bar' : 'chart-bar report-bar report-bar--unreadable'}
                  {...(bar.readable ? {} : { fill: `url(#${patternId})` })}
                >
                  <title>{`${bar.label}: ${bar.percent || bar.counts}${bar.note ? ` — ${bar.note}` : ''}`}</title>
                </rect>
                {bar.value === 0 && (
                  <line
                    x1={labelW} x2={labelW}
                    y1={barTop + 1} y2={barTop + BAR.thickness - 1}
                    className="chart-witness" shapeRendering="crispEdges"
                  />
                )}
                <text
                  // In the gutter past the scale's end, not at the bar's end.
                  // Beside the bar it ran over the end tick on any row near
                  // 100%; out here the figures also form one aligned column,
                  // which is how the table below reads them.
                  x={labelW + plotW + BAR.gap * 2}
                  y={mid + 4}
                  className={bar.readable ? 'chart-value' : 'chart-value report-value--unreadable'}
                >
                  {/* Bracketed exactly as in the tables, so the drawing and the
                      numbers under it mark a small sample the same way. */}
                  {bar.percent ? `${bar.readable ? bar.percent : `[${bar.percent}]`} · ${bar.counts}` : bar.counts}
                </text>
              </g>
            );
          })}
        </svg>
      </figure>
      {!tableless && (
        <div className="chart-data">
          <table>
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr><th scope="col">Group</th><th scope="col">{valueHeading}</th><th scope="col">Sample</th></tr>
            </thead>
            <tbody>
              {bars.map((bar) => (
                <tr key={bar.key}>
                  <th scope="row">{bar.label}</th>
                  {/* Bracketed here too. The warning beside it in the next
                      column is not enough: this cell is what gets read, sorted
                      and copied out on its own. */}
                  <td className={bar.readable ? undefined : 'report-rate--unreadable'}>
                    {bar.percent ? (bar.readable ? bar.percent : `[${bar.percent}]`) : '—'}
                  </td>
                  <td>{bar.counts}{bar.readable ? '' : ` — ${bar.note}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const COL = { height: 190, left: 34, right: 8, top: 14, bottom: 34 } as const;
const COL_FALLBACK_WIDTH = 640;

export interface CountColumnChartProps {
  readonly columns: readonly CountColumn[];
  readonly title: string;
  readonly summary: string;
  /** Marks the median column, so the middle of the distribution is visible and not inferred. */
  readonly medianKey?: string | null;
}

/** A distribution: one column per bucket or level, counts printed on each. */
export function CountColumnChart({ columns, title, summary, medianKey }: CountColumnChartProps) {
  const id = useId();
  const { ref, width } = useMeasuredWidth(COL_FALLBACK_WIDTH);
  const max = niceCeiling(Math.max(1, ...columns.map((c) => c.count)));
  const plotW = Math.max(40, width - COL.left - COL.right);
  const plotH = COL.height - COL.top - COL.bottom;
  const slot = columns.length ? plotW / columns.length : plotW;
  // A 2px surface gap between neighbouring fills, so two columns never merge
  // into one shape.
  const barW = Math.max(4, slot - 6);

  return (
    <div className="report-chart">
      <figure className="chart" ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${COL.height}`}
          width={width}
          height={COL.height}
          role="img"
          aria-labelledby={`${id}-t ${id}-d`}
          className="chart-svg"
        >
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{`${summary} ${columns.map((c) => `${c.label}: ${c.count}.`).join(' ')}`}</desc>
          <line
            x1={COL.left} x2={COL.left + plotW} y1={COL.top + plotH} y2={COL.top + plotH}
            className="chart-baseline" shapeRendering="crispEdges"
          />
          {columns.map((column, index) => {
            const h = scaleLength(column.count, max, plotH);
            const x = COL.left + index * slot + (slot - barW) / 2;
            const y = COL.top + plotH - h;
            return (
              <g key={column.key}>
                <rect
                  x={x} y={y} width={barW} height={h}
                  rx={barRadius(barW, h)} ry={barRadius(barW, h)}
                  className={medianKey === column.key ? 'chart-bar report-bar report-bar--median' : 'chart-bar report-bar'}
                >
                  <title>{`${column.label}: ${column.count}`}</title>
                </rect>
                {column.count === 0 && (
                  <line
                    x1={x} x2={x + barW} y1={COL.top + plotH} y2={COL.top + plotH}
                    className="chart-witness" shapeRendering="crispEdges"
                  />
                )}
                <text x={x + barW / 2} y={y - 5} textAnchor="middle" className="chart-value">{column.count}</text>
                <text x={x + barW / 2} y={COL.top + plotH + 16} textAnchor="middle" className="chart-axis">{column.label}</text>
              </g>
            );
          })}
        </svg>
      </figure>
      <div className="chart-data">
        <table>
          <caption className="sr-only">{title}</caption>
          <thead><tr><th scope="col">Band</th><th scope="col">Interviews</th></tr></thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.key}><th scope="row">{column.label}</th><td>{column.count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
