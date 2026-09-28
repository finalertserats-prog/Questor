import { describe, it, expect } from 'vitest';
import {
  durationText, isTranscriptRead, needsJumpControl, nextReadState, progressLabel, readFraction, readNote,
  reviewFacts, REVIEW_SECTION_ID, TRANSCRIPT_END_ID, transcriptRows, transcriptViewFromBlind, transcriptViewFromInterview,
} from '../src/components/review/transcriptReaderModel';

/**
 * The transcript the reviewer reads before recording a verdict: how each turn
 * is labelled, how far they have read, and when the page may call the
 * transcript read. Nothing here is persisted; it is the page's own guidance.
 */

const NAMES = { own: 'Ownership', comm: 'Communication' };

describe('transcript rows', () => {
  it('labels the interviewer by name when the session recorded one', () => {
    const [row] = transcriptRows([{ index: 0, speaker: 'agent', text: 'Hello', startMs: 0, competencyId: 'own' }], NAMES, { interviewer: 'Maya' });
    expect(row.label).toBe('Maya');
  });

  it('falls back to "Interviewer" for a session with no name', () => {
    const [row] = transcriptRows([{ index: 0, speaker: 'agent', text: 'Hello' }], NAMES, {});
    expect(row.label).toBe('Interviewer');
  });

  it('names the candidate on their own turns', () => {
    const [row] = transcriptRows([{ index: 1, speaker: 'candidate', text: 'I led it.' }], NAMES, { candidate: 'Priya Sharma' });
    expect(row).toMatchObject({ voice: 'candidate', label: 'Priya Sharma' });
  });

  it('tags an interviewer turn with the competency it was asked for', () => {
    const [row] = transcriptRows([{ index: 0, speaker: 'agent', text: 'Tell me', competencyId: 'own' }], NAMES, {});
    expect(row.competency).toBe('Ownership');
  });

  it('leaves the candidate turn untagged so the tag reads as the question, not the answer', () => {
    const [row] = transcriptRows([{ index: 1, speaker: 'candidate', text: 'I led it.', competencyId: 'own' }], NAMES, {});
    expect(row.competency).toBeNull();
  });

  it('shows no tag for a competency the scorecard no longer names', () => {
    const [row] = transcriptRows([{ index: 0, speaker: 'agent', text: 'Tell me', competencyId: 'gone' }], NAMES, {});
    expect(row.competency).toBeNull();
  });

  it('stamps a turn with minutes and seconds into the interview', () => {
    const [row] = transcriptRows([{ index: 0, speaker: 'agent', text: 'Hello', startMs: 65_000 }], NAMES, {});
    expect(row.stamp).toBe('01:05');
  });

  it('has no stamp when the source did not record one', () => {
    const [row] = transcriptRows([{ index: 0, speaker: 'agent', text: 'Hello' }], NAMES, {});
    expect(row.stamp).toBeNull();
  });

  it('says when the candidate pressed Leave rather than spoke', () => {
    const [row] = transcriptRows([{ index: 3, speaker: 'candidate', text: '', source: 'leave_button' }], NAMES, {});
    expect(row.leftByButton).toBe(true);
  });

  it('keeps the turns in transcript order', () => {
    const rows = transcriptRows([
      { index: 1, speaker: 'candidate', text: 'B' }, { index: 0, speaker: 'agent', text: 'A' },
    ], NAMES, {});
    expect(rows.map((r) => r.text)).toEqual(['A', 'B']);
  });
});

describe('read progress', () => {
  it('is 0 before the block has entered the viewport', () => {
    expect(readFraction({ top: 900, height: 2000, viewportHeight: 800 })).toBe(0);
  });

  it('counts the part of the block above the bottom of the viewport as read', () => {
    expect(readFraction({ top: 0, height: 2000, viewportHeight: 800 })).toBe(0.4);
  });

  it('is 1 once the bottom of the block is in view', () => {
    expect(readFraction({ top: -1300, height: 2000, viewportHeight: 800 })).toBe(1);
  });

  it('never exceeds 1 however far past the block the page scrolls', () => {
    expect(readFraction({ top: -5000, height: 2000, viewportHeight: 800 })).toBe(1);
  });

  it('treats an empty block as read', () => {
    expect(readFraction({ top: 100, height: 0, viewportHeight: 800 })).toBe(1);
  });

  it('is read only at the end', () => {
    expect([isTranscriptRead(0.99), isTranscriptRead(1)]).toEqual([false, true]);
  });

  it('stays read after the reviewer scrolls back up', () => {
    expect(nextReadState(true, 0.2)).toBe(true);
  });

  it('becomes read when the end comes into view', () => {
    expect(nextReadState(false, 1)).toBe(true);
  });

  it('labels the progress as a percentage', () => {
    expect(progressLabel(0.4)).toBe('Read 40%');
  });

  it('labels the end as read', () => {
    expect(progressLabel(1)).toBe('Transcript read');
  });

  it('asks the reviewer to read first, and confirms once they have', () => {
    expect([readNote(false), readNote(true)]).toEqual([
      'Read the transcript before recording your review.',
      'Transcript read.',
    ]);
  });
});

describe('jumping to the review', () => {
  it('names the review section so a control can scroll to it', () => {
    expect(REVIEW_SECTION_ID).toBe('assessment-review');
  });

  it('names the end of the transcript so the note can be checked against it', () => {
    expect(TRANSCRIPT_END_ID).toBe('transcript-end');
  });

  it('offers the jump only when the transcript is taller than the screen', () => {
    expect([
      needsJumpControl({ height: 500, viewportHeight: 800 }),
      needsJumpControl({ height: 1200, viewportHeight: 800 }),
    ]).toEqual([false, true]);
  });
});

describe('the compact header', () => {
  it('lists candidate, role, interviewer, date and duration in that order', () => {
    const facts = reviewFacts({
      candidate: 'Priya Sharma', role: 'Data Engineer', interviewer: 'Maya',
      startedAt: '2026-09-17T09:00:00Z', completedAt: '2026-09-17T09:32:00Z', durationMinutes: 30,
    });
    expect(facts.map((f) => f.label)).toEqual(['Candidate', 'Role', 'Interviewer', 'Date', 'Duration']);
  });

  it('measures the duration from start to finish', () => {
    expect(durationText({ startedAt: '2026-09-17T09:00:00Z', completedAt: '2026-09-17T09:32:00Z', durationMinutes: 30 })).toBe('32 min');
  });

  it('falls back to the planned length when the interview has no recorded end', () => {
    expect(durationText({ startedAt: '2026-09-17T09:00:00Z', completedAt: null, durationMinutes: 30 })).toBe('30 min planned');
  });

  it('says when nothing about the length is known', () => {
    expect(durationText({ startedAt: null, completedAt: null, durationMinutes: null })).toBe('—');
  });

  it('names the interviewer as "AI interviewer" when the session has no name', () => {
    const facts = reviewFacts({ candidate: 'P', role: 'R', interviewer: null, startedAt: null, completedAt: null, durationMinutes: null });
    expect(facts.find((f) => f.label === 'Interviewer')?.value).toBe('AI interviewer');
  });
});

describe('building the view from each source', () => {
  it('reads the interview transcript with the names the assessment already knows', () => {
    const view = transcriptViewFromInterview(
      {
        transcript: [{ index: 0, speaker: 'agent', text: 'Hi', startMs: 0, competencyId: 'own' }],
        session: { interviewer: 'Maya', startedAt: '2026-09-17T09:00:00Z', completedAt: '2026-09-17T09:30:00Z', durationMinutes: 30 },
      },
      { candidate: 'Priya Sharma', role: 'Data Engineer', competencyNames: NAMES },
    );
    expect(view.rows[0]).toMatchObject({ label: 'Maya', competency: 'Ownership' });
    expect(view.facts.map((f) => f.value)).toEqual(['Priya Sharma', 'Data Engineer', 'Maya', expect.any(String), '30 min']);
  });

  it('copes with an older server that sends no session facts', () => {
    const view = transcriptViewFromInterview(
      { transcript: [] },
      { candidate: 'Priya Sharma', role: 'Data Engineer', competencyNames: NAMES },
    );
    expect(view.facts.find((f) => f.label === 'Interviewer')?.value).toBe('AI interviewer');
  });

  it('reads the blind view, which names its own competencies', () => {
    const view = transcriptViewFromBlind({
      candidate: { id: 'c1', name: 'Priya Sharma' }, role: { id: 'r1', title: 'Data Engineer' },
      session: { interviewer: null, startedAt: null, completedAt: null, durationMinutes: 45 },
      competencies: [{ id: 'own', name: 'Ownership' }],
      transcript: [{ index: 0, speaker: 'agent', text: 'Hi', startMs: 0, competencyId: 'own' }],
    });
    expect(view.rows[0]).toMatchObject({ label: 'Interviewer', competency: 'Ownership' });
    expect(view.facts.find((f) => f.label === 'Duration')?.value).toBe('45 min planned');
  });
});
