/**
 * Peer adapter — the three local AI CLIs, behind one interface.
 *
 * The harness runs on the CLIs already installed on this machine rather than on
 * API keys: no third key on the VPS, no per-sweep bill, and it keeps the lanes
 * at parity with how the rest of the toolchain talks to these models.
 *
 * Every call goes through execFile with the prompt as a single argv entry and no
 * shell. The harness feeds these processes generated job descriptions and
 * resumes — text with quotes, backticks and `$` in it — and a shell string would
 * turn that content into syntax.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

export type PeerId = 'claude' | 'gemini' | 'codex';

export const PEER_IDS: readonly PeerId[] = ['claude', 'gemini', 'codex'] as const;

/** The two peers a given peer interviews, giving six ordered pairs across the matrix. */
export function otherPeers(peer: PeerId): PeerId[] {
  return PEER_IDS.filter((p) => p !== peer);
}

function councilDir(): string {
  const dir = process.env.COUNCIL_DIR || `${homedir()}/.claude/council`;
  // Forward slashes throughout: this path is handed to bash, which does not
  // reliably treat a backslash as a separator.
  return dir.replace(/\\/g, '/');
}

export interface PeerCommand {
  command: string;
  args: string[];
}

/** Resolve a peer to an executable and its argv. Pure, so it can be asserted on. */
export function peerCommand(peer: PeerId, prompt: string): PeerCommand {
  switch (peer) {
    case 'claude':
      // Via bash rather than directly, because on Windows `claude` is a .cmd
      // shim and Node refuses to spawn those without a shell. The command string
      // is FIXED and the prompt arrives as the positional `$1`, so this is not a
      // shell-interpolation path — nothing in the prompt can become syntax.
      return { command: 'bash', args: ['-c', 'claude -p "$1"', '--', prompt] };
    case 'gemini':
      // The Google lane runs through agy; gemini_call.sh is the compatibility
      // entry point every other caller in the toolchain already uses.
      return { command: 'bash', args: [`${councilDir()}/gemini_call.sh`, prompt] };
    case 'codex':
      return { command: 'bash', args: [`${councilDir()}/codex_call.sh`, prompt, 'default'] };
  }
}

/** Strip ANSI colour codes a CLI may emit when it thinks it has a terminal. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

export interface PeerCallOptions {
  /** Milliseconds before the peer is abandoned. Peers are slow; be generous. */
  timeoutMs?: number;
  /** Attempts including the first. */
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Ceiling on a prompt passed as a process argument.
 *
 * Windows caps a whole command line near 32,767 characters, and Node reports
 * going over as `spawn ENAMETOOLONG` — an error about a *filename*, raised
 * before the peer is ever contacted. A sweep hit exactly this: the judge prompt
 * embeds a full transcript, every judge call died, each cell recorded an error
 * instead of a verdict, and the run produced a report with no numbers in it.
 *
 * So the limit is enforced here, below the ceiling and with a message that says
 * what actually happened. A prompt this large is a caller bug — bound the
 * content, do not raise this number.
 */
export const MAX_PROMPT_CHARS = 28_000;

/** Run one peer and return its stdout. Throws if it fails every attempt. */
export async function callPeer(peer: PeerId, prompt: string, opts: PeerCallOptions = {}): Promise<string> {
  if (prompt.length > MAX_PROMPT_CHARS) {
    // Thrown rather than truncated: silently cutting a prompt would change what
    // the peer was asked without saying so, and a judge scoring half a
    // transcript is worse than a judge that visibly failed.
    throw new Error(
      `${peer}: prompt is ${prompt.length} characters, over the ${MAX_PROMPT_CHARS} limit for a process argument ` +
      '(Windows caps a command line near 32767 and reports it as ENAMETOOLONG). Bound the content before calling.',
    );
  }
  const retries = Math.max(1, opts.retries ?? 2);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { command, args } = peerCommand(peer, prompt);
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          command,
          args,
          { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
          (err, stdout, stderr) => {
            // A non-zero exit with usable stdout still counts: these wrappers
            // sometimes exit non-zero after printing a perfectly good answer.
            if (err && !String(stdout).trim()) return reject(new Error(`${peer} failed: ${err.message} ${String(stderr).slice(0, 400)}`));
            resolve(String(stdout));
          },
        );
      });
      const text = stripAnsi(out).trim();
      if (!text) throw new Error(`${peer} returned nothing`);
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${peer} failed`);
}

// --- JSON extraction --------------------------------------------------------

/**
 * Pull the first complete JSON value out of a peer's reply.
 *
 * Peers wrap JSON in fences, preface it with "Sure, here you go", and append a
 * closing remark — all of which JSON.parse rejects. Fenced blocks are tried
 * first because a model that fenced its answer has told us where the answer is;
 * a stray brace in the preamble ("I considered {not this}") would otherwise win
 * on position alone.
 *
 * Returns null rather than throwing: a peer producing prose instead of JSON is
 * an ordinary event in a 144-interview sweep, not an exception.
 */
export function extractJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  const text = stripAnsi(raw);

  for (const block of fencedBlocks(text)) {
    const parsed = firstBalancedValue<T>(block);
    if (parsed !== null) return parsed;
  }
  return firstBalancedValue<T>(text);
}

function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```(?:[a-zA-Z]+)?\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Scan for the first `{`/`[` that opens a balanced, parseable value. */
function firstBalancedValue<T>(text: string): T | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = matchingClose(text, i);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(i, end + 1)) as T;
    } catch {
      // Not valid after all — keep looking further along the string.
    }
  }
  return null;
}

/** Index of the brace closing the one at `start`, or -1. String-aware. */
function matchingClose(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// --- JSON calls -------------------------------------------------------------

export interface PeerJsonOptions<T> extends PeerCallOptions {
  validate: (raw: unknown) => T;
  /** Label used in error messages so a failed sweep says which step broke. */
  label?: string;
  /**
   * A skeleton of the wanted object, used for the last-ditch ask.
   *
   * Worth supplying for any analytical task. Asked to "assess an interview", a
   * model reaches for the format that suits the work — a markdown report with
   * headings — and no amount of "reply with JSON only" appended to a long prompt
   * reliably overrides that. Handing it a form to fill in does.
   */
  responseTemplate?: string;
}

/**
 * Call a peer and insist on JSON back, escalating how bluntly it is asked.
 *
 * Three attempts, because peers fail this way often enough that a long sweep
 * otherwise loses its results to formatting rather than to anything about
 * interviewing. A baseline run lost four of six judgements to models that
 * answered a request for structured scores with a beautifully written report.
 */
export async function callPeerJson<T>(peer: PeerId, prompt: string, opts: PeerJsonOptions<T>): Promise<T> {
  const label = opts.label ?? 'peer call';
  const strict = `${prompt}\n\nReply with JSON only. No prose, no explanation, no code fence, no markdown headings.`;

  let lastProblem = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ask = buildAsk(attempt, strict, lastProblem, opts.responseTemplate);

    let raw: string;
    try {
      raw = await callPeer(peer, ask, { ...opts, retries: 1 });
    } catch (e) {
      lastProblem = e instanceof Error ? e.message : String(e);
      // A prompt over the size ceiling will not get smaller by asking again.
      if (lastProblem.includes('over the')) break;
      continue;
    }

    const parsed = extractJson(raw);
    if (parsed === null) {
      lastProblem = `no JSON found in the reply (started "${raw.slice(0, 120)}")`;
      continue;
    }
    try {
      return opts.validate(parsed);
    } catch (e) {
      lastProblem = `JSON did not match the expected shape: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(`${label}: ${peer} produced no usable JSON after 3 attempts. Last problem: ${lastProblem}`);
}

/** Escalate from the full request, to a correction, to a bare form to fill in. */
function buildAsk(attempt: number, strict: string, lastProblem: string, template?: string): string {
  if (attempt === 1) return strict;
  if (attempt === 2) {
    return `${strict}\n\nYour previous reply could not be used: ${lastProblem}\nReturn only the JSON value, starting with { and ending with }.`;
  }
  // Last chance. Drop the reasoning framing entirely — it is what pulls a model
  // towards writing a report — and ask only for the filled-in structure.
  return template
    ? `${strict}\n\nTwo previous replies could not be parsed. Output NOTHING except this JSON object with the values filled in. Your first character must be { and your last must be }.\n\n${template}`
    : `${strict}\n\nTwo previous replies could not be parsed (${lastProblem}). Output NOTHING except the JSON object. Your first character must be { and your last must be }.`;
}
