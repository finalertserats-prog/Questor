import { describe, it, expect } from 'vitest';
import { attentionRow, attentionSummary, type AttentionItem } from '../src/components/needsAttentionModel';

const base: AttentionItem = {
  kind: 'review', at: '2026-09-20T10:00:00.000Z', sessionId: 's1', assessmentId: 'a1',
  candidate: { id: 'c1', name: 'Ada' }, role: { id: 'r1', title: 'Data Engineer' },
};

describe('attentionRow', () => {
  it('sends a review to its assessment', () => {
    expect(attentionRow(base).to).toBe('/assessments/a1');
  });

  it('sends an accommodation request to the interview, where it can be read and reopened', () => {
    expect(attentionRow({ ...base, kind: 'accommodation', assessmentId: null }).to).toBe('/interviews/s1');
  });

  it('sends a request to talk to the candidate', () => {
    expect(attentionRow({ ...base, kind: 'human_request' }).to).toBe('/candidates/c1');
  });

  it('sends a held feedback email to its assessment, where it is released or kept', () => {
    expect(attentionRow({ ...base, kind: 'feedback_held' }).to).toBe('/assessments/a1');
  });

  it('says a held feedback email is waiting for a decision', () => {
    expect(attentionRow({ ...base, kind: 'feedback_held' }).what).toBe('Feedback email held for a decision');
  });
});

describe('attentionSummary', () => {
  it('names each kind that is waiting', () => {
    expect(attentionSummary({ review: 3, accommodation: 1, human_request: 0 })).toBe('3 reviews · 1 accommodation request');
  });

  it('counts held feedback emails', () => {
    expect(attentionSummary({ review: 0, accommodation: 0, human_request: 0, feedback_held: 2 })).toBe('2 held feedback emails');
  });

  it('reads counts from an older server that does not report held emails', () => {
    expect(attentionSummary({ review: 1, accommodation: 0, human_request: 0 })).toBe('1 review');
  });

  it('is empty when nothing waits', () => {
    expect(attentionSummary({ review: 0, accommodation: 0, human_request: 0 })).toBe('');
  });
});
