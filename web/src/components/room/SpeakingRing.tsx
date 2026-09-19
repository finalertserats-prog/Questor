import { useEffect, useRef, useState, type RefObject } from 'react';
import { isSpeakingNow, smoothLevel, withAlpha } from './roomLevelModel';

/**
 * The per-frame side of a participant's voice: a canvas "living ring" with a
 * radial glow, a tiny avatar scale and five status bars, all from one smoothed
 * level. Drawn straight onto the elements from a frame loop rather than through
 * React state — sixty re-renders a second of the whole room was what the old
 * meter cost.
 */

const DRAW_FLOOR = 0.02;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function drawRing(canvas: HTMLCanvasElement, level: number, t: number, reduced: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const cx = w / 2;
  const cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  if (level < DRAW_FLOOR) return;
  const color = getComputedStyle(canvas).color;
  const base = w * 0.29;
  if (reduced) {
    // Still says "this person is speaking", without anything moving.
    ctx.strokeStyle = withAlpha(color, 0.9);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, base + 8, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  const glow = ctx.createRadialGradient(cx, cy, base * 0.8, cx, cy, base + 44 * level + 10);
  glow.addColorStop(0, withAlpha(color, 0.33));
  glow.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, base + 54, 0, Math.PI * 2);
  ctx.fill();
  // The radius wobbles with the voice rather than pulsing on a fixed beat.
  ctx.strokeStyle = withAlpha(color, 0.85);
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 90) {
    const r = base + 10 + level * (10 + 6 * Math.sin(a * 5 + t / 180) + 4 * Math.sin(a * 3 - t / 260));
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = withAlpha(color, 0.25 * level);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, base + 30 + level * 16, 0, Math.PI * 2);
  ctx.stroke();
}

function drawBars(bars: HTMLElement, level: number, t: number, reduced: boolean): void {
  Array.from(bars.children).forEach((bar, i) => {
    const wave = reduced ? 1 : Math.sin(t / 90 + i * 1.7);
    const height = level < DRAW_FLOOR ? 3 : 4 + level * (8 + 6 * wave);
    (bar as HTMLElement).style.height = `${Math.max(3, Math.min(14, height))}px`;
  });
}

function drawWave(canvas: HTMLCanvasElement, level: number, t: number, reduced: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const count = 24;
  const gap = w / count;
  const live = level > DRAW_FLOOR;
  ctx.fillStyle = live ? getComputedStyle(canvas).color : 'rgba(255, 255, 255, 0.18)';
  for (let i = 0; i < count; i += 1) {
    const shape = reduced ? 0.6 : Math.abs(Math.sin(t / 120 + i * 0.7));
    const v = live ? shape * level * 0.9 + 0.08 : 0.08;
    const bh = Math.max(4, v * h);
    ctx.fillRect(i * gap + 2, (h - bh) / 2, gap - 4, bh);
  }
}

export interface LevelTargets {
  readonly ring?: HTMLCanvasElement | null;
  readonly avatar?: HTMLElement | null;
  readonly bars?: HTMLElement | null;
  readonly wave?: HTMLCanvasElement | null;
}

/**
 * Run the frame loop for one voice. Returns whether that voice is audibly
 * speaking, with hysteresis, as React state that changes only on a flip.
 */
export function useVoiceFrames(getLevel: () => number, targets: () => LevelTargets): boolean {
  const [speaking, setSpeaking] = useState(false);
  const getLevelRef = useRef(getLevel);
  const targetsRef = useRef(targets);
  getLevelRef.current = getLevel;
  targetsRef.current = targets;

  useEffect(() => {
    let raf = 0;
    let level = 0;
    let speakingNow = false;
    const reduced = prefersReducedMotion();
    const frame = (t: number) => {
      level = smoothLevel(level, getLevelRef.current());
      const { ring, avatar, bars, wave } = targetsRef.current();
      if (ring) drawRing(ring, level, t, reduced);
      if (bars) drawBars(bars, level, t, reduced);
      if (wave) drawWave(wave, level, t, reduced);
      if (avatar) avatar.style.transform = reduced ? '' : `scale(${1 + level * 0.05})`;
      const next = isSpeakingNow(speakingNow, level);
      if (next !== speakingNow) {
        speakingNow = next;
        setSpeaking(next);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return speaking;
}

/** The avatar with its ring. Size and colour come from the stylesheet. */
export function RingedAvatar({ initial, ringRef, avatarRef }: {
  initial: string;
  ringRef: RefObject<HTMLCanvasElement>;
  avatarRef: RefObject<HTMLDivElement>;
}) {
  return (
    <div className="room-avatar-wrap">
      <canvas ref={ringRef} className="room-ring" width={280} height={280} aria-hidden="true" />
      <div ref={avatarRef} className="room-avatar" aria-hidden="true">{initial}</div>
    </div>
  );
}

export function LevelBars({ barsRef }: { barsRef: RefObject<HTMLSpanElement> }) {
  return (
    <span ref={barsRef} className="room-bars" aria-hidden="true">
      <i /><i /><i /><i /><i />
    </span>
  );
}
