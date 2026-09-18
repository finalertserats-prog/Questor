import { useActiveTheme } from './theme';
import {
  brandLogoAlt,
  brandLogoBox,
  brandLogoSources,
  brandLogoTone,
  priorityAttributes,
  type BrandLogoTone,
  type BrandLogoVariant,
} from './brandLogoModel';

interface BrandLogoProps {
  /** 'mark' is the Q alone; 'lockup' adds the name; 'full' adds the tagline too. */
  variant: BrandLogoVariant;
  /** Drawn height in CSS pixels. The width follows the artwork's proportions. */
  size: number;
  /** Set on a surface that paints itself one way whatever the theme (the interview room is always dark). */
  surfaceTone?: BrandLogoTone;
  /** True when the product's name is already beside the logo in text. */
  decorative?: boolean;
  /** Only for the one logo that is above the fold on first paint. */
  priority?: boolean;
  className?: string;
}

/**
 * The Questor logo, in the cut that suits the theme on screen.
 *
 * The theme comes from the app, not from prefers-color-scheme: switching the
 * in-app toggle re-renders this with the other file. The width and height
 * attributes reserve the space before the file arrives, so nothing jumps.
 */
export function BrandLogo({ variant, size, surfaceTone, decorative = false, priority = false, className }: BrandLogoProps) {
  const tone = brandLogoTone(useActiveTheme(), surfaceTone);
  const { src, webp } = brandLogoSources(variant, tone);
  const { width, height } = brandLogoBox(variant, size);
  const classes = className ? `brand-logo ${className}` : 'brand-logo';

  const img = (
    <img
      className={classes}
      src={src}
      alt={brandLogoAlt(variant, decorative)}
      width={width}
      height={height}
      decoding="async"
      {...priorityAttributes(priority)}
    />
  );

  if (!webp) return img;
  // key: a <picture> keeps its chosen source across a src change in some
  // browsers; remounting when the file changes guarantees the switch is seen.
  return (
    <picture key={`${variant}-${tone}`} className="brand-picture">
      <source type="image/webp" srcSet={webp} />
      {img}
    </picture>
  );
}
