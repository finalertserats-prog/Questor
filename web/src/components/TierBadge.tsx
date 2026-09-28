import { useId } from 'react';
import {
  DETAIL_FROM_PX, GRADIENT_STOPS, ROSETTES, TIER_METAL,
  crystalFacets, octagonPath, rosettePath, signalBars, type TierKey,
} from './tierBadgeGeometry';

/**
 * The tier badge — one component for all four tiers and every size.
 *
 * Inline SVG rather than the raster medallions used on the pipeline track: a
 * badge is exported at print resolution beside a certificate, and it appears
 * at 20px in a table row. One vector draws both; two PNGs would not.
 *
 * Decorative by default, like Icon. In a journey row the tier is already
 * written beside it, and a screen reader announcing "Silver badge, Silver —
 * assessed by …" reads the word twice. Pass `label` where the badge stands
 * alone and is the only thing naming the tier.
 */

export interface TierBadgeProps {
  readonly tier: TierKey;
  /** 20, 24, 30 and 36 in the app; 118 beside a certificate seal. */
  readonly size: number;
  readonly label?: string;
  readonly className?: string;
}

export function TierBadge({ tier, size, label, className }: TierBadgeProps) {
  // One document can hold a dozen badges; a shared gradient id would make them
  // all take whichever metal was defined last.
  const uid = useId().replace(/:/g, '');
  const metal = TIER_METAL[tier];
  // The guilloché and the hallmark are engraved only from 56px: below that
  // they muddy the metal instead of reading as detail.
  const detailed = size >= DETAIL_FROM_PX;
  const gradientId = `tier-metal-${uid}`;
  const clipId = `tier-field-${uid}`;
  const rim = octagonPath(50, 47);

  const access = label
    ? ({ role: 'img' as const, 'aria-label': label })
    : ({ 'aria-hidden': true, focusable: 'false' as const });

  return (
    <svg
      viewBox="0 0 100 100" width={size} height={size} {...access}
      className={className ? `tier-badge ${className}` : 'tier-badge'}
    >
      <defs>
        <linearGradient id={gradientId} x1=".1" y1="0" x2=".9" y2="1">
          {GRADIENT_STOPS.map(([offset, stop]) => (
            <stop key={offset} offset={`${offset}%`} stopColor={metal.gradient[stop]} />
          ))}
        </linearGradient>
        {detailed && tier !== 'diamond' && (
          <clipPath id={clipId}><path d={octagonPath(50, 40)} /></clipPath>
        )}
      </defs>

      {tier === 'diamond' ? (
        <>
          <path d={rim} fill={`url(#${gradientId})`} opacity={0.34} />
          <path d={rim} fill="none" stroke={metal.dark} strokeWidth={detailed ? 1.2 : 2.2} opacity={0.5} />
          <Crystal tier={tier} gradientId={gradientId} detailed={detailed} radius={detailed ? 33 : 35} />
        </>
      ) : (
        <>
          <path d={rim} fill={`url(#${gradientId})`} />
          {detailed && (
            <>
              <path d={octagonPath(50, 41)} fill="none" stroke={metal.dark} strokeWidth={0.7} opacity={0.45} />
              <g clipPath={`url(#${clipId})`}>
                {ROSETTES.map(([outer, wheel, pen, turns], i) => (
                  <path
                    key={outer} d={rosettePath(outer, wheel, pen, turns, 50, 50, 1)}
                    fill="none" stroke={metal.dark} strokeWidth={0.38} opacity={0.24 - i * 0.06}
                  />
                ))}
              </g>
            </>
          )}
          <path d={rim} fill="none" stroke={metal.dark} strokeWidth={detailed ? 1.1 : 2.2} opacity={0.55} />
          <Signal tier={tier} detailed={detailed} />
          {detailed && metal.hallmark && (
            <text
              x={50} y={80} textAnchor="middle" fontFamily="IBM Plex Mono, monospace"
              fontSize={5.4} fontWeight={400} fill={metal.dark} opacity={0.3} letterSpacing={0.9}
            >
              {metal.hallmark}
            </text>
          )}
        </>
      )}
    </svg>
  );
}


/**
 * Four bars, always. The unearned ones are engraved — a dark recess with a
 * bright edge — never left out: the badge says "one of four", and a Bronze
 * showing a single bar on bare metal says "one", which is a different claim.
 * The `data-tier-bar` attributes are what a test counts, because the count is
 * the meaning and it has regressed before.
 */
function Signal({ tier, detailed }: { tier: TierKey; detailed: boolean }) {
  const metal = TIER_METAL[tier];
  const inset = detailed ? 0.9 : 1;
  return (
    <g>
      {signalBars(metal.struckBars, detailed).map((bar, i) => (
        <g key={i} data-tier-bar={bar.struck ? 'struck' : 'engraved'}>
          <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={1} fill={metal.dark} opacity={bar.struck ? 0.3 : 0.22} />
          <rect
            x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={1} fill="none"
            stroke={metal.light} strokeWidth={detailed ? 0.9 : 1.1} opacity={bar.struck ? 0 : 0.45}
          />
          {bar.struck && (
            <>
              <rect
                x={bar.x + inset} y={bar.y + inset} width={bar.width - inset * 2} height={bar.height - inset * 2}
                rx={0.7} fill={metal.light} opacity={0.97}
              />
              {detailed && (
                <rect x={bar.x + 0.9} y={bar.y + 0.9} width={(bar.width - 1.8) * 0.32} height={bar.height - 1.8} fill={metal.dark} opacity={0.16} />
              )}
            </>
          )}
        </g>
      ))}
    </g>
  );
}

function Crystal({ tier, gradientId, detailed, radius }: { tier: TierKey; gradientId: string; detailed: boolean; radius: number }) {
  const metal = TIER_METAL[tier];
  const table = octagonPath(50, radius * 0.46);
  return (
    <g>
      <path d={octagonPath(50, radius)} fill={`url(#${gradientId})`} opacity={0.96} />
      <g>
        {crystalFacets(radius).map((facet, i) => (
          <g key={i}>
            <path d={facet.path} fill={facet.lit ? '#ffffff' : metal.dark} opacity={facet.lit ? 0.3 : 0.16} />
            <line
              x1={facet.spoke.x1} y1={facet.spoke.y1} x2={facet.spoke.x2} y2={facet.spoke.y2}
              stroke="#ffffff" strokeWidth={detailed ? 0.8 : 1.2} opacity={0.5}
            />
          </g>
        ))}
      </g>
      <path d={table} fill="#ffffff" opacity={0.72} />
      <path d={table} fill="none" stroke={metal.dark} strokeWidth={detailed ? 0.7 : 1} opacity={0.4} />
      {detailed && (
        <>
          <line x1={50 - radius * 0.3} y1={50} x2={50 + radius * 0.3} y2={50} stroke="#fff" strokeWidth={1.1} opacity={0.85} />
          <line x1={50} y1={50 - radius * 0.3} x2={50} y2={50 + radius * 0.3} stroke="#fff" strokeWidth={1.1} opacity={0.85} />
        </>
      )}
      <path d={octagonPath(50, radius)} fill="none" stroke={metal.dark} strokeWidth={detailed ? 1 : 1.6} opacity={0.55} />
    </g>
  );
}
