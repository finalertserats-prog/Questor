import type { EvidenceSpan, TurnRecord } from '../domain/types.js';

// Evidence extractor (BRD 16.1). Links candidate statements to transcript spans
// per competency. It only references what was said — no facial/emotion/private
// attribute interpretation.

export function extractEvidence(turns: TurnRecord[], competencyId: string): EvidenceSpan[] {
  return turns
    .filter((t) => t.speaker === 'candidate' && t.competencyId === competencyId && t.text.trim().length > 0)
    .map((t) => ({
      turnId: t.id,
      startMs: t.startMs,
      endMs: t.endMs,
      quote: t.text.length > 240 ? t.text.slice(0, 237) + '…' : t.text,
    }));
}

export function evidenceByCompetency(turns: TurnRecord[]): Record<string, EvidenceSpan[]> {
  const map: Record<string, EvidenceSpan[]> = {};
  for (const t of turns) {
    if (t.speaker === 'candidate' && t.competencyId && !t.competencyId.startsWith('__')) {
      (map[t.competencyId] ??= []).push({
        turnId: t.id, startMs: t.startMs, endMs: t.endMs,
        quote: t.text.length > 240 ? t.text.slice(0, 237) + '…' : t.text,
      });
    }
  }
  return map;
}
