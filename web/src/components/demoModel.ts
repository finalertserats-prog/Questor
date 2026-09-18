export function formatDemoCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60).toString().padStart(2, '0');
  const seconds = (total % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/**
 * Pages a demo visitor does not see: organisation settings and admin, which
 * the server refuses to a demo anyway. Setting up roles and candidates stays,
 * because showing how an interview is set up is what the demo is for — the
 * server's creation caps are what keep that bounded.
 */
export function demoHidesNavItem(path: string): boolean {
  return ['/settings', '/admin', '/audit'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function demoHasEnded(endsAtIso: string, nowMs: number): boolean {
  return Date.parse(endsAtIso) <= nowMs;
}
