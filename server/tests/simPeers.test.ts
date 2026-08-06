import { describe, it, expect } from 'vitest';
import { extractJson, peerCommand, PEER_IDS, otherPeers, callPeer, MAX_PROMPT_CHARS } from '../src/sim/peers.js';

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads an object wrapped in a fenced block', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nHope that helps!')).toEqual({ a: 1 });
  });

  it('reads a fenced block with no language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads an object buried in prose on both sides', () => {
    expect(extractJson('Sure. {"a":1} Let me know if you need more.')).toEqual({ a: 1 });
  });

  it('reads a top-level array', () => {
    expect(extractJson('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('keeps braces that live inside strings', () => {
    expect(extractJson('{"q":"what about {this}?"}')).toEqual({ q: 'what about {this}?' });
  });

  it('keeps escaped quotes inside strings', () => {
    expect(extractJson('{"q":"she said \\"hello\\" once"}')).toEqual({ q: 'she said "hello" once' });
  });

  it('prefers the fenced block over a stray brace in the preamble', () => {
    const raw = 'I considered {not this} first.\n```json\n{"a":"this one"}\n```';
    expect(extractJson(raw)).toEqual({ a: 'this one' });
  });

  it('returns null rather than throwing when there is no JSON at all', () => {
    expect(extractJson('I cannot help with that.')).toBeNull();
    expect(extractJson('')).toBeNull();
  });

  it('returns null on a truncated object rather than guessing', () => {
    expect(extractJson('{"a":1')).toBeNull();
  });
});

describe('peerCommand', () => {
  it('routes claude through the headless CLI', () => {
    const c = peerCommand('claude', 'hello');
    expect(c.command).toBe('bash');
    // The prompt is a positional parameter, never spliced into the script text —
    // Node cannot spawn the Windows .cmd shim directly, so bash is the wrapper.
    expect(c.args[1]).toBe('claude -p "$1"');
    expect(c.args[1]).not.toContain('hello');
    expect(c.args).toContain('hello');
  });

  it('routes gemini and codex through their council scripts', () => {
    for (const peer of ['gemini', 'codex'] as const) {
      const c = peerCommand(peer, 'hello');
      expect(c.command).toBe('bash');
      expect(c.args[0]).toMatch(new RegExp(`${peer}_call\\.sh$`));
      expect(c.args).toContain('hello');
    }
  });

  it('passes the prompt as one argument, never through a shell string', () => {
    // A prompt carrying quotes, backticks or $ must not be able to reach a shell
    // as syntax — the harness feeds it generated JDs and resumes.
    const nasty = 'Say `id`; echo $HOME "quoted"';
    for (const peer of PEER_IDS) {
      expect(peerCommand(peer, nasty).args).toContain(nasty);
    }
  });
});

describe('otherPeers', () => {
  it('returns the two peers a given peer can interview', () => {
    expect(otherPeers('claude')).toEqual(['gemini', 'codex']);
    expect(otherPeers('gemini')).toEqual(['claude', 'codex']);
    expect(otherPeers('codex')).toEqual(['claude', 'gemini']);
  });

  it('yields six ordered interviewer/candidate pairs across the matrix', () => {
    const pairs = PEER_IDS.flatMap((i) => otherPeers(i).map((c) => `${i}->${c}`));
    expect(pairs).toHaveLength(6);
    expect(new Set(pairs).size).toBe(6);
  });
});

describe('prompt size ceiling', () => {
  it('refuses an oversized prompt with an actionable message', async () => {
    // Windows reports going over the command-line limit as `spawn ENAMETOOLONG`
    // — an error about a filename, raised before the peer is contacted. Caught
    // here so it can never again read as "the peer failed".
    await expect(callPeer('claude', 'x'.repeat(MAX_PROMPT_CHARS + 1))).rejects.toThrow(/over the \d+ limit/);
  });

  it('does not truncate silently, which would change the question asked', async () => {
    await expect(callPeer('claude', 'x'.repeat(MAX_PROMPT_CHARS + 1))).rejects.toThrow(/Bound the content/);
  });
});
