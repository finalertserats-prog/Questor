/**
 * Voice A/B — synthesise the same interviewer lines through both paid TTS
 * connectors so the choice is made on evidence rather than on a preference.
 *
 * A word about what this does and does not decide. Latency, cost, size and
 * reliability are measured here, because they are measurable. Whether a voice
 * sounds like a person is NOT scored here: the peers reach these models through
 * text CLIs and cannot listen to audio, and a number invented for "realism"
 * would look like evidence while being nothing of the kind. So this writes the
 * files out side by side and leaves that judgement to whoever plays them.
 *
 * Run: npm run sim:voice -w server
 *   TTS keys are read from the environment. A provider with no key is reported
 *   as skipped rather than failed — nothing here will ask for a credential.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { synthesizeElevenLabs, synthesizeOpenAI } from '../providers/speech.js';
import { config } from '../config.js';

/**
 * Lines drawn from real simulated interviews rather than invented for the demo.
 * They cover what the voice actually has to carry: the consent disclosure, a
 * warm opening, a hard probe, an acknowledgement, and the close.
 */
export const VOICE_SAMPLE_LINES: readonly string[] = [
  "Hello, and thank you for joining. I'm Schranders, an AI interviewer for this first-round conversation. Your voice is transcribed as we talk — no audio recording is kept, but the written transcript is, and a person on the hiring team reads it.",
  'Great. To start, could you briefly tell me about your current role and the project you\'ve worked on that\'s most relevant to this position?',
  'That\'s a strong example, so let me push on it. What was the best argument against the approach you took, and why did you go ahead anyway?',
  'Thanks for the correction — Pharma, noted.',
  'That covers everything I wanted to ask. Before we wrap up, do you have any questions about the role or the process?',
] as const;

export interface VoiceProviderResult {
  provider: 'openai' | 'elevenlabs';
  configured: boolean;
  skippedReason?: string;
  clips: Array<{ index: number; chars: number; bytes: number; ms: number; file?: string; error?: string }>;
}

/** Per-1000-character list prices, for an order-of-magnitude cost line only. */
const APPROX_USD_PER_1K_CHARS: Record<'openai' | 'elevenlabs', number> = {
  openai: 0.015,
  elevenlabs: 0.15,
};

async function runProvider(
  provider: 'openai' | 'elevenlabs',
  lines: readonly string[],
  outDir: string,
): Promise<VoiceProviderResult> {
  const configured = provider === 'openai'
    ? !!config.llm.openaiKey
    : !!(process.env.ELEVENLABS_API_KEY || config.tts.elevenKey);

  if (!configured) {
    return {
      provider,
      configured: false,
      skippedReason: provider === 'openai'
        ? 'OPENAI_API_KEY is not set, so OpenAI TTS cannot be exercised.'
        : 'ELEVENLABS_API_KEY is not set, so ElevenLabs cannot be exercised.',
      clips: [],
    };
  }

  const dir = `${outDir}/${provider}`;
  mkdirSync(dir, { recursive: true });
  const synth = provider === 'openai' ? synthesizeOpenAI : synthesizeElevenLabs;

  const clips: VoiceProviderResult['clips'] = [];
  for (const [index, line] of lines.entries()) {
    const startedAt = Date.now();
    try {
      const audio = await synth(line);
      const file = `${dir}/${String(index + 1).padStart(2, '0')}.mp3`;
      writeFileSync(file, audio);
      clips.push({ index, chars: line.length, bytes: audio.length, ms: Date.now() - startedAt, file });
    } catch (e) {
      clips.push({
        index, chars: line.length, bytes: 0, ms: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { provider, configured: true, clips };
}

export function renderVoiceReport(results: VoiceProviderResult[], lines: readonly string[]): string {
  const out: string[] = [];
  out.push('# Interviewer voice — A/B');
  out.push('');
  out.push('Measured below: latency, size, failure rate and an order-of-magnitude cost.');
  out.push('**Not** measured below: how human the voice sounds. Play the clips and decide that yourself —');
  out.push('the harness cannot hear, and a fabricated realism score would read as evidence.');
  out.push('');

  out.push('## Measured');
  out.push('');
  out.push('| Provider | Status | Clips OK | Mean latency | Total bytes | Approx cost per 1k interviews |');
  out.push('|---|---|---|---|---|---|');
  for (const r of results) {
    if (!r.configured) {
      out.push(`| ${r.provider} | skipped | — | — | — | — |`);
      continue;
    }
    const ok = r.clips.filter((c) => !c.error);
    const meanMs = ok.length ? ok.reduce((a, c) => a + c.ms, 0) / ok.length : NaN;
    const bytes = ok.reduce((a, c) => a + c.bytes, 0);
    const chars = r.clips.reduce((a, c) => a + c.chars, 0);
    // A 20-minute interview is roughly 25 interviewer turns of this length.
    const perInterview = (chars / lines.length) * 25;
    const cost = (perInterview / 1000) * APPROX_USD_PER_1K_CHARS[r.provider] * 1000;
    out.push(
      `| ${r.provider} | ok | ${ok.length}/${r.clips.length} | ${Number.isFinite(meanMs) ? `${Math.round(meanMs)} ms` : '—'} | ${bytes} | ~$${cost.toFixed(0)} |`,
    );
  }
  out.push('');

  const skipped = results.filter((r) => !r.configured);
  if (skipped.length) {
    out.push('## Skipped');
    out.push('');
    for (const r of skipped) out.push(`- **${r.provider}** — ${r.skippedReason}`);
    out.push('');
  }

  const failed = results.flatMap((r) => r.clips.filter((c) => c.error).map((c) => ({ p: r.provider, c })));
  if (failed.length) {
    out.push('## Failed clips');
    out.push('');
    for (const f of failed) out.push(`- **${f.p}** line ${f.c.index + 1}: ${f.c.error}`);
    out.push('');
  }

  out.push('## Listen');
  out.push('');
  out.push('Same line, both voices, in order:');
  out.push('');
  for (const [i, line] of lines.entries()) {
    out.push(`${i + 1}. "${line}"`);
    for (const r of results.filter((x) => x.configured)) {
      const clip = r.clips[i];
      out.push(`   - ${r.provider}: ${clip?.file ?? `failed — ${clip?.error ?? 'no clip'}`}`);
    }
  }
  out.push('');
  return out.join('\n');
}

async function main() {
  const outDir = 'sim-results/voice';
  mkdirSync(outDir, { recursive: true });

  console.log('\n=== Interviewer voice A/B ===\n');
  const results: VoiceProviderResult[] = [];
  for (const provider of ['openai', 'elevenlabs'] as const) {
    console.log(`Synthesising ${VOICE_SAMPLE_LINES.length} lines through ${provider}...`);
    const r = await runProvider(provider, VOICE_SAMPLE_LINES, outDir);
    if (!r.configured) console.log(`  skipped: ${r.skippedReason}`);
    results.push(r);
  }

  const report = renderVoiceReport(results, VOICE_SAMPLE_LINES);
  console.log(`\n${report}`);
  writeFileSync(`${outDir}/README.md`, report, 'utf8');
  console.log(`Written: ${outDir}/README.md`);
}

if (process.argv[1] && process.argv[1].endsWith('voiceAB.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
