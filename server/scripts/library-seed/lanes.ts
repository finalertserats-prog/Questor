import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SeedLane } from '../../src/library/seedFormat.js';

/**
 * The three Brahmastra lanes as child processes on the owner's laptop. These
 * are personal-subscription developer CLIs used for OFFLINE authoring only;
 * nothing in the server imports this directory.
 *
 *   claude  — `claude -p` with no tools, no settings files, no MCP servers
 *   codex   — `codex exec -s read-only --skip-git-repo-check -` (default model; never pinned, never a bypass flag)
 *   gemini  — agy through `~/.claude/council/gemini_call.sh - default 1 5`. The
 *             "plan" mode prefixes a planning template that turns every reply
 *             into a numbered plan, so the plain read path is used instead.
 *             AGY_SKIP_AUTH_PROBE=1: agy's pre-call auth probe (`agy plugin list`)
 *             has a 5 s limit that it misses on this laptop (about 12 s) even
 *             when signed in; the call itself proves auth, and this runner's own
 *             timeout bounds a hang.
 *
 * Every prompt goes in on stdin and the working directory is set by spawn, so
 * the cmd.exe line for the npm shims holds fixed tokens only: no prompt text
 * and no path for cmd.exe to expand or split.
 */

export type Lane = SeedLane;

export interface CliResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly ms: number;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly timeoutMs: number;
  /** An empty scratch directory: no lane should see a repository. */
  readonly cwd: string;
}

export type CliRunner = (lane: Lane, prompt: string, opts: RunOptions) => Promise<CliResult>;

const IS_WINDOWS = process.platform === 'win32';

function gitBash(): string {
  return process.env.SEED_BASH ?? (IS_WINDOWS ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
}

/** The command line for a lane. Shell-free except where Windows needs cmd.exe to find an npm shim. */
export function laneCommand(lane: Lane): { readonly command: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>> } {
  switch (lane) {
    case 'claude': {
      const args = ['-p', '--restricted', '--tools', '""', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text'];
      return IS_WINDOWS ? { command: 'cmd.exe', args: ['/d', '/s', '/c', ['claude', ...args].join(' ')] } : { command: 'claude', args: args.map((a) => (a === '""' ? '' : a)) };
    }
    case 'codex': {
      const args = ['exec', '-s', 'read-only', '--skip-git-repo-check', '-'];
      return IS_WINDOWS ? { command: 'cmd.exe', args: ['/d', '/s', '/c', ['codex', ...args].join(' ')] } : { command: 'codex', args };
    }
    case 'gemini':
      return { command: gitBash(), args: [join(process.env.SEED_COUNCIL_DIR ?? join(homedir(), '.claude', 'council'), 'gemini_call.sh'), '-', 'default', '1', '5'], env: { AGY_SKIP_AUTH_PROBE: '1' } };
    default: {
      const never: never = lane;
      throw new Error(`unknown lane ${String(never)}`);
    }
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (IS_WINDOWS) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Runs one lane with the prompt on stdin, bounded by a timeout that kills the whole process tree. */
export const spawnRunner: CliRunner = (lane, prompt, opts) => new Promise((resolve) => {
  const started = Date.now();
  const { command, args, env } = laneCommand(lane);
  const child = spawn(command, [...args], { cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: IS_WINDOWS && command === 'cmd.exe', env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  child.on('error', (err) => {
    clearTimeout(timer);
    resolve({ ok: false, stdout, stderr: `${stderr}\n${err.message}`, exitCode: null, ms: Date.now() - started, timedOut });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ ok: code === 0 && !timedOut, stdout, stderr, exitCode: code, ms: Date.now() - started, timedOut });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(prompt, 'utf8');
});

// --- Usage limits ----------------------------------------------------------------------

export type LaneFailure =
  | { readonly kind: 'usage_limit'; readonly until: Date; readonly parsed: boolean }
  | { readonly kind: 'transient'; readonly reason: string };

const LIMIT_PATTERN = /usage limit|hit your (usage )?limit|limit reached|rate.?limit|quota|resource.?exhausted|too many requests|\b429\b|credit balance/i;
/** When a lane says it is limited but not until when. */
export const DEFAULT_LIMIT_COOLDOWN_MS = 60 * 60_000;
const SAFETY_MARGIN_MS = 60_000;
const MONTHS = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

function atTimeOfDay(text: string, now: Date): Date | null {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1] ?? m[4]);
  const minute = Number(m[2] ?? m[5] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * When a lane's usage limit lifts, from its own message, or null when the
 * message does not say. Understands "try again at 5:12 PM", "try again at
 * Sep 23rd, 2026 3:45 PM", "try again in 3 hours", "resets 5pm (Asia/Calcutta)"
 * and "usage limit reached|<epoch seconds>".
 */
export function parseResetTime(text: string, now: Date): Date | null {
  const epoch = /limit reached\|(\d{9,13})/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const rel = /(?:try again|resets?|available)\s+in\s+(?:about\s+)?(\d+)\s*(second|sec|minute|min|hour|hr|day)s?/i.exec(text);
  if (rel) {
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith('s') ? 1000 : unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + Number(rel[1]) * ms);
  }
  const abs = /(?:try again at|resets?(?: at| on)?)\s+([^\n(·]+?)(?:\s*\(|\.\s|\.$|$|\n)/im.exec(text);
  if (!abs) return null;
  const phrase = abs[1].replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/\s+at\s+/i, ' ').trim();
  if (MONTHS.test(phrase)) {
    const parsed = Date.parse(phrase);
    if (Number.isFinite(parsed) && parsed > now.getTime()) return new Date(parsed);
  }
  return atTimeOfDay(phrase, now);
}

/** Why a lane call failed: a usage limit (with when it lifts) or something worth retrying soon. */
export function classifyFailure(result: CliResult, now: Date): LaneFailure {
  const text = `${result.stderr}\n${result.stdout}`;
  if (LIMIT_PATTERN.test(text)) {
    const until = parseResetTime(text, now);
    return until
      ? { kind: 'usage_limit', until: new Date(until.getTime() + SAFETY_MARGIN_MS), parsed: true }
      : { kind: 'usage_limit', until: new Date(now.getTime() + DEFAULT_LIMIT_COOLDOWN_MS), parsed: false };
  }
  if (result.timedOut) return { kind: 'transient', reason: 'timeout' };
  if (result.exitCode !== 0) return { kind: 'transient', reason: `exit ${result.exitCode ?? 'spawn_error'}` };
  return { kind: 'transient', reason: 'empty_reply' };
}
