import { deflateSync } from 'node:zlib';
import type { Paint, Point, Shape } from './badgeGeometry.js';
import { hallmarkGlyphs } from './strokeGlyphs.js';

/**
 * A scanline rasteriser and a PNG encoder, in about three hundred lines.
 *
 * Questor has to answer `badge.png`, and nothing on this server can turn a
 * vector into pixels: there is no sharp, no node-canvas, no resvg, and pdfkit
 * only reads PNGs. The alternatives were to add a native dependency — which on
 * this deployment means a compiler on the VPS and a new supply-chain surface
 * for one decorative file — or to screenshot a page, which the credentials
 * contract forbids outright.
 *
 * So the badge is rasterised here from the same geometry the SVG and the PDF
 * seal are drawn from. Everything arriving is a polygon, which keeps this to
 * one algorithm: sample each pixel row at five sub-scanlines, find where the
 * edges cross each one, and fill the spans where the non-zero winding rule
 * says we are inside.
 */

/** Sub-scanlines per pixel row. Five is where the guilloché stops shimmering. */
const SUBSAMPLES = 5;

/**
 * Below this, a stroke is drawn at this width with its opacity scaled down
 * instead.
 *
 * A quarter-pixel-wide guilloché line that happens to lie between two
 * sub-scanlines disappears entirely, so the field comes out with gaps in it
 * at some sizes and not others. Browsers solve it the same way, which is also
 * why this matches what the approved mockup looks like on screen.
 */
const HAIRLINE = 0.8;

export const MIN_BADGE_PX = 32;
export const MAX_BADGE_PX = 1024;

interface Edge {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly dir: number;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseHex(colour: string): Rgb {
  const hex = colour.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function edgesOf(subpaths: readonly (readonly Point[])[], close: boolean): readonly Edge[] {
  const edges: Edge[] = [];
  for (const points of subpaths) {
    const last = close ? points.length : points.length - 1;
    for (let i = 0; i < last; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a.y === b.y) continue; // Horizontal edges never cross a scanline.
      edges.push(b.y > a.y ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: 1 } : { x0: b.x, y0: b.y, x1: a.x, y1: a.y, dir: -1 });
    }
  }
  return edges;
}

/**
 * A stroked polyline as filled quads, one per segment, plus a disc at each
 * join.
 *
 * Overlaps between neighbouring quads are free rather than a problem: they are
 * filled as subpaths of a single non-zero path, so a point covered twice is
 * still inside exactly once. That only holds if every quad winds the same way,
 * which is why the orientation is normalised below — two quads of opposite
 * winding would cancel where they overlap and leave a notch at every join.
 */
function strokeToPolygons(points: readonly Point[], closed: boolean, width: number): readonly (readonly Point[])[] {
  const half = width / 2;
  const polygons: (readonly Point[])[] = [];
  const segments = closed ? points.length : points.length - 1;

  for (let i = 0; i < segments; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    const quad = [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ];
    let area = 0;
    for (let k = 0; k < 4; k += 1) {
      const p = quad[k];
      const q = quad[(k + 1) % 4];
      area += p.x * q.y - q.x * p.y;
    }
    polygons.push(area < 0 ? [...quad].reverse() : quad);
  }

  // Round joins, as octagonal discs. SVG's default join is a miter, but the
  // only shapes here with a corner sharp enough to tell them apart are the
  // octagon outlines, where the difference at a 135-degree corner is a
  // fraction of the stroke's own width.
  const joins = closed ? points.length : points.length - 2;
  for (let i = 0; i < joins; i += 1) {
    const centre = points[closed ? i : i + 1];
    polygons.push(
      Array.from({ length: 8 }, (_unused, k) => {
        const angle = (k / 8) * Math.PI * 2;
        return { x: centre.x + Math.cos(angle) * half, y: centre.y + Math.sin(angle) * half };
      }),
    );
  }
  return polygons;
}

/** Adds `weight` of coverage across a horizontal span, with fractional ends. */
function addSpan(row: Float32Array, from: number, to: number, weight: number, width: number): void {
  const x0 = Math.max(from, 0);
  const x1 = Math.min(to, width);
  if (x1 <= x0) return;
  const first = Math.floor(x0);
  const lastEdge = Math.ceil(x1) - 1;
  if (first >= lastEdge) {
    row[first] += (x1 - x0) * weight;
    return;
  }
  row[first] += (first + 1 - x0) * weight;
  for (let p = first + 1; p < lastEdge; p += 1) row[p] += weight;
  row[lastEdge] += (x1 - lastEdge) * weight;
}

interface Canvas {
  /** Premultiplied RGBA, so compositing is a plain lerp and never divides by zero alpha. */
  readonly premul: Float32Array;
  readonly size: number;
}

function colourAt(paint: Paint, x: number, y: number): Rgb {
  if (paint.kind === 'solid') return parseHex(paint.colour);
  const dx = paint.to.x - paint.from.x;
  const dy = paint.to.y - paint.from.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((x - paint.from.x) * dx + (y - paint.from.y) * dy) / lengthSq));
  const stops = paint.stops;
  let lower = stops[0];
  let upper = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (t >= stops[i].at && t <= stops[i + 1].at) {
      lower = stops[i];
      upper = stops[i + 1];
      break;
    }
  }
  const span = upper.at - lower.at;
  const k = span === 0 ? 0 : (t - lower.at) / span;
  const a = parseHex(lower.colour);
  const b = parseHex(upper.colour);
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

/**
 * Fills one path into the canvas.
 *
 * Edges are bucketed by pixel row first. Without that, every sub-scanline
 * walks all of a rosette's sixteen hundred edges whether they are anywhere
 * near it or not, and a single badge takes seconds.
 */
function fillPath(
  canvas: Canvas,
  polygons: readonly (readonly Point[])[],
  paint: Paint,
  scale: number,
  gradientScale: number,
): void {
  const { size } = canvas;
  const edges = edgesOf(polygons.map((poly) => poly.map((p) => ({ x: p.x * scale, y: p.y * scale }))), true);
  if (!edges.length) return;

  let top = Infinity;
  let bottom = -Infinity;
  for (const e of edges) {
    if (e.y0 < top) top = e.y0;
    if (e.y1 > bottom) bottom = e.y1;
  }
  const rowFrom = Math.max(0, Math.floor(top));
  const rowTo = Math.min(size - 1, Math.ceil(bottom));
  if (rowTo < rowFrom) return;

  const buckets: Edge[][] = Array.from({ length: rowTo - rowFrom + 1 }, () => []);
  for (const e of edges) {
    const from = Math.max(rowFrom, Math.floor(e.y0));
    const to = Math.min(rowTo, Math.ceil(e.y1));
    for (let row = from; row <= to; row += 1) buckets[row - rowFrom].push(e);
  }

  const coverage = new Float32Array(size);
  const weight = 1 / SUBSAMPLES;
  const crossings: { x: number; dir: number }[] = [];

  for (let py = rowFrom; py <= rowTo; py += 1) {
    const bucket = buckets[py - rowFrom];
    if (!bucket.length) continue;
    coverage.fill(0);

    for (let s = 0; s < SUBSAMPLES; s += 1) {
      const sy = py + (s + 0.5) / SUBSAMPLES;
      crossings.length = 0;
      for (const e of bucket) {
        if (sy < e.y0 || sy >= e.y1) continue;
        crossings.push({ x: e.x0 + ((sy - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i += 1) {
        winding += crossings[i].dir;
        if (winding !== 0) addSpan(coverage, crossings[i].x, crossings[i + 1].x, weight, size);
      }
    }

    for (let px = 0; px < size; px += 1) {
      const cov = coverage[px];
      if (cov <= 0.0005) continue;
      const alpha = Math.min(1, cov) * paint.alpha;
      if (alpha <= 0) continue;
      const rgb = colourAt(paint, (px + 0.5) / gradientScale, (py + 0.5) / gradientScale);
      const i = (py * size + px) * 4;
      const keep = 1 - alpha;
      canvas.premul[i] = rgb.r * alpha + canvas.premul[i] * keep;
      canvas.premul[i + 1] = rgb.g * alpha + canvas.premul[i + 1] * keep;
      canvas.premul[i + 2] = rgb.b * alpha + canvas.premul[i + 2] * keep;
      canvas.premul[i + 3] = alpha + canvas.premul[i + 3] * keep;
    }
  }
}

function drawShape(canvas: Canvas, shape: Shape, scale: number): void {
  if (shape.op === 'fill') {
    fillPath(canvas, shape.subpaths, shape.paint, scale, scale);
    return;
  }
  if (shape.op === 'stroke') {
    const device = shape.width * scale;
    // Hairline handling: keep the line visible and pay for it in opacity.
    const width = device < HAIRLINE ? HAIRLINE / scale : shape.width;
    const alpha = device < HAIRLINE ? shape.alpha * (device / HAIRLINE) : shape.alpha;
    const polygons = shape.subpaths.flatMap((points) => strokeToPolygons(points, shape.closed, width));
    fillPath(canvas, polygons, { kind: 'solid', colour: shape.colour, alpha }, scale, scale);
    return;
  }
  for (const run of hallmarkGlyphs(shape)) {
    if (run.kind === 'fill') {
      fillPath(canvas, [run.points], { kind: 'solid', colour: shape.colour, alpha: shape.alpha }, scale, scale);
      continue;
    }
    const polygons = strokeToPolygons(run.points, run.closed, run.width);
    fillPath(canvas, polygons, { kind: 'solid', colour: shape.colour, alpha: shape.alpha }, scale, scale);
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Eight-bit RGBA, no interlacing, one filter byte of zero a row. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const at = y * (width * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, at + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Shapes in the badge's 0–100 space to PNG bytes on a transparent ground.
 *
 * Transparent rather than white: the badge is dropped into a slide, a letter
 * and a dark-mode page, and a white square behind it is exactly the thing
 * people complain about.
 */
export function rasterisePng(shapes: readonly Shape[], size: number): Buffer {
  const px = Math.round(Math.min(MAX_BADGE_PX, Math.max(MIN_BADGE_PX, size)));
  const canvas: Canvas = { premul: new Float32Array(px * px * 4), size: px };
  const scale = px / 100;
  for (const shape of shapes) drawShape(canvas, shape, scale);

  const out = new Uint8Array(px * px * 4);
  for (let i = 0; i < px * px; i += 1) {
    const alpha = canvas.premul[i * 4 + 3];
    if (alpha <= 0) continue;
    out[i * 4] = Math.round(Math.min(255, canvas.premul[i * 4] / alpha));
    out[i * 4 + 1] = Math.round(Math.min(255, canvas.premul[i * 4 + 1] / alpha));
    out[i * 4 + 2] = Math.round(Math.min(255, canvas.premul[i * 4 + 2] / alpha));
    out[i * 4 + 3] = Math.round(Math.min(255, alpha * 255));
  }
  return encodePng(out, px, px);
}
