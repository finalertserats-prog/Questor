import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewFactsStrip, TranscriptReader, TranscriptReadNote, type TranscriptReaderProps } from '../src/components/review/TranscriptReader';
import { reviewFacts, transcriptRows } from '../src/components/review/transcriptReaderModel';

/**
 * The transcript block the review page opens with. Server-rendered, so what
 * is asserted is the markup a reviewer or a screen reader meets — not the
 * scroll arithmetic, which transcriptReaderModel.test.ts covers.
 */

const rows = transcriptRows([
  { index: 0, speaker: 'agent', text: 'Tell me about an incident you owned.', startMs: 0, competencyId: 'own' },
  { index: 1, speaker: 'candidate', text: 'I led the rollback.', startMs: 12_000, competencyId: 'own' },
  { index: 2, speaker: 'candidate', text: '', startMs: 65_000, source: 'leave_button' },
], { own: 'Ownership' }, { interviewer: 'Maya', candidate: 'Priya Sharma' });

const props = (over: Partial<TranscriptReaderProps> = {}): TranscriptReaderProps => ({
  status: 'ready', rows, fraction: 0.4, read: false, showJump: true, onJump: () => undefined, onRetry: () => undefined, error: '',
  ...over,
});

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe('the transcript reader', () => {
  it('labels each turn with who spoke', () => {
    const out = html(createElement(TranscriptReader, props()));
    expect(out).toContain('Maya');
    expect(out).toContain('Priya Sharma');
  });

  it('sets the candidate apart from the interviewer', () => {
    const out = html(createElement(TranscriptReader, props()));
    expect(out).toContain('reader-turn is-interviewer');
    expect(out).toContain('reader-turn is-candidate');
  });

  it('stamps a turn with its time into the interview', () => {
    expect(html(createElement(TranscriptReader, props()))).toContain('<time class="reader-stamp">00:12</time>');
  });

  it('tags the interviewer turn with its competency', () => {
    expect(html(createElement(TranscriptReader, props()))).toContain('Ownership');
  });

  it('says when the candidate chose to leave instead of showing an empty line', () => {
    expect(html(createElement(TranscriptReader, props()))).toContain('Candidate chose to leave the interview');
  });

  it('shows how far the reviewer has read', () => {
    expect(html(createElement(TranscriptReader, props({ fraction: 0.4 })))).toContain('Read 40%');
  });

  it('offers a jump to the review on a long transcript', () => {
    expect(html(createElement(TranscriptReader, props({ showJump: true })))).toContain('Jump to review');
  });

  it('keeps the jump out of a transcript that fits on the screen', () => {
    expect(html(createElement(TranscriptReader, props({ showJump: false })))).not.toContain('Jump to review');
  });

  it('ends with a marker the page can scroll to', () => {
    expect(html(createElement(TranscriptReader, props()))).toContain('id="transcript-end"');
  });

  it('says so while the transcript is loading', () => {
    expect(html(createElement(TranscriptReader, props({ status: 'loading', rows: [] })))).toContain('Loading the transcript');
  });

  it('shows the failure and a retry rather than an empty block', () => {
    const out = html(createElement(TranscriptReader, props({ status: 'failed', rows: [], error: 'The transcript could not be loaded.' })));
    expect(out).toContain('The transcript could not be loaded.');
    expect(out).toContain('Try again');
  });

  it('says when the interview left no transcript', () => {
    expect(html(createElement(TranscriptReader, props({ rows: [] })))).toContain('No transcript');
  });
});

describe('the read note', () => {
  it('asks the reviewer to read first', () => {
    expect(html(createElement(TranscriptReadNote, { read: false }))).toContain('Read the transcript before recording your review.');
  });

  it('confirms once the end has been on screen', () => {
    const out = html(createElement(TranscriptReadNote, { read: true }));
    expect(out).toContain('Transcript read.');
    expect(out).toContain('is-read');
  });
});

describe('the compact header', () => {
  it('lists the facts as a description list', () => {
    const facts = reviewFacts({
      candidate: 'Priya Sharma', role: 'Data Engineer', interviewer: 'Maya',
      startedAt: '2026-09-17T09:00:00Z', completedAt: '2026-09-17T09:32:00Z', durationMinutes: 30,
    });
    const out = html(createElement(ReviewFactsStrip, { facts }));
    expect(out).toContain('<dt>Interviewer</dt><dd>Maya</dd>');
    expect(out).toContain('<dd>32 min</dd>');
  });
});
