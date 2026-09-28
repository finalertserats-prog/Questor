import { useEffect, useRef, useState } from 'react';

/**
 * The rendered width of the element `ref` is attached to, in CSS pixels.
 *
 * Every chart in the app draws its viewBox at that many user units, so one
 * user unit is one CSS pixel. A fixed viewBox with `width: 100%` looks like it
 * scales only the drawing, but an SVG scales uniformly: on a 1010px column a
 * 480-unit viewBox magnifies everything 2.1x, type included.
 *
 * Falls back to `fallback` before the first measurement and anywhere
 * ResizeObserver is missing (jsdom in the unit tests), so a chart always has
 * sane geometry to draw with.
 */
export function useMeasuredWidth(fallback: number) {
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
