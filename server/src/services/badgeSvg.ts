import { badgeLabel, badgeShapes, type Paint, type Point, type Shape, type Tier } from './badgeGeometry.js';

/**
 * The badge as an `.svg` file.
 *
 * Vector, so it survives being dropped into a slide at any size, and carrying
 * a `<title>` so a screen reader says "Silver badge" instead of "image".
 *
 * Every attribute value that could come from outside is a number or a colour
 * from the tier table, so there is nothing here an attacker supplies — but the
 * escaping below is unconditional anyway, because the day someone adds a
 * candidate's name to this file is the day a missing escape becomes an
 * injected `</svg><script>`.
 */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Two decimals: the badge is 100 units wide, so this is a thousandth of it. */
function n(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function pathData(subpaths: readonly (readonly Point[])[], closed: boolean): string {
  return subpaths
    .map((points) => `M${points.map((p) => `${n(p.x)},${n(p.y)}`).join('L')}${closed ? 'Z' : ''}`)
    .join(' ');
}

function paintAttrs(paint: Paint, id: string): { readonly fill: string; readonly opacity: string } {
  const opacity = paint.alpha < 1 ? ` fill-opacity="${n(paint.alpha)}"` : '';
  return { fill: paint.kind === 'solid' ? paint.colour : `url(#${id})`, opacity };
}

function gradientDef(paint: Paint, id: string): string {
  if (paint.kind !== 'linear') return '';
  const stops = paint.stops.map((s) => `<stop offset="${n(s.at * 100)}%" stop-color="${s.colour}"/>`).join('');
  // User space, not the object bounding box the mockup uses: the stops have
  // already been resolved against each shape's own extent in badgeGeometry, and
  // re-mapping them a second time here would light the Diamond crystal from a
  // different angle than the planchet under it.
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(paint.from.x)}" y1="${n(paint.from.y)}" x2="${n(paint.to.x)}" y2="${n(paint.to.y)}">${stops}</linearGradient>`;
}

function renderShape(shape: Shape, index: number, prefix: string): { readonly def: string; readonly body: string } {
  if (shape.op === 'text') {
    const opacity = shape.alpha < 1 ? ` fill-opacity="${n(shape.alpha)}"` : '';
    return {
      def: '',
      body:
        `<text x="${n(shape.at.x)}" y="${n(shape.at.y)}" text-anchor="middle" font-family="IBM Plex Mono, ui-monospace, monospace"` +
        ` font-size="${n(shape.size)}" letter-spacing="${n(shape.tracking)}" fill="${shape.colour}"${opacity}>${escapeXml(shape.text)}</text>`,
    };
  }
  if (shape.op === 'stroke') {
    const opacity = shape.alpha < 1 ? ` stroke-opacity="${n(shape.alpha)}"` : '';
    return {
      def: '',
      body: `<path d="${pathData(shape.subpaths, shape.closed)}" fill="none" stroke="${shape.colour}" stroke-width="${n(shape.width)}"${opacity}/>`,
    };
  }
  const id = `${prefix}${index}`;
  const { fill, opacity } = paintAttrs(shape.paint, id);
  return {
    def: gradientDef(shape.paint, id),
    body: `<path d="${pathData(shape.subpaths, true)}" fill="${fill}"${opacity}/>`,
  };
}

export function badgeSvg(tier: Tier, size: number): string {
  // The gradient id has to survive being inlined beside other badges.
  //
  // Every badge used to declare `qg0`. A standalone .svg file is its own
  // document so that was safe, and it is the only way this renderer is
  // consumed today — but ids are document-wide, so the moment two are pasted
  // into one page every `url(#qg0)` resolves to whichever came first and the
  // rest silently wear its metal. Valid SVG, no error, wrong badge. The
  // browser component has guarded against exactly this since it was written;
  // this one had not, and the trap was sprung by a page showing all four
  // tiers together, where three of them came out Bronze.
  //
  // Derived from tier and size rather than randomised, because the route
  // snaps `?size=` to six values so that one badge is one fixed asset. Two
  // renders of the same tier at the same size must stay byte-identical, and
  // they may share an id precisely because they are the same drawing.
  const prefix = `qg-${tier}-${n(size)}-`;
  const parts = badgeShapes(tier, size).map((shape, index) => renderShape(shape, index, prefix));
  const defs = parts.map((p) => p.def).filter(Boolean).join('');
  const body = parts.map((p) => p.body).join('');
  const label = escapeXml(badgeLabel(tier));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${n(size)}" height="${n(size)}" role="img" aria-label="${label}">` +
    `<title>${label}</title>` +
    (defs ? `<defs>${defs}</defs>` : '') +
    body +
    '</svg>'
  );
}
