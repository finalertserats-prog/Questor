// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VerdictPanel } from '../src/components/assessment/VerdictPanel';
import { SkillsGrid, type SkillView } from '../src/components/assessment/SkillsGrid';
import { AssessmentTranscript } from '../src/components/assessment/AssessmentTranscript';
import { SwotFold } from '../src/components/assessment/AssessmentFolds';
import { consequenceCopy } from '../src/components/assessment/verdictFlowModel';
import type { TranscriptRow } from '../src/components/review/transcriptReaderModel';

/**
 * The parts of the assessment page a reviewer actually touches: the decision
 * at the top, the evidence chips, and the transcript they mark.
 */

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const CONSEQUENCE = {
  verdict: 'PROCEED' as const, fromStageKey: 'silver', fromStageLabel: 'Silver',
  toStageKey: 'gold', toStageLabel: 'Gold', moves: true, closes: null, alreadyDecided: false,
};

function panel(over: Record<string, unknown> = {}) {
  const props = {
    ai: { recommendation: 'PROCEED', confidence: 0.82, caveat: 'Thin evidence on Leading a team.' },
    candidate: 'Arjun Mehta',
    verdict: '' as const,
    onVerdict: () => undefined,
    reason: '',
    onReason: () => undefined,
    copy: null,
    canSubmit: false,
    submitting: false,
    onSubmit: () => undefined,
    refusal: '',
    ...over,
  };
  return render(h(VerdictPanel, props as never));
}

describe('the verdict panel', () => {
  it('leads with the AI recommendation in the one vocabulary', () => {
    panel();
    expect(screen.getByTestId('verdict-ai').textContent).toContain('Proceed');
  });

  it('shows the caveat beside the recommendation, so it is read with it', () => {
    panel();
    expect(screen.getByTestId('verdict-caveat').textContent).toContain('Thin evidence on Leading a team.');
  });

  it('offers the three verdicts as one radio group', () => {
    panel();
    expect(screen.getByRole('radiogroup', { name: 'Your decision' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((b) => b.textContent)).toEqual(['Proceed', 'Consider', 'Do not progress']);
  });

  it('records nothing until a verdict is chosen', () => {
    panel();
    expect(screen.getAllByRole('radio').every((b) => b.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(screen.queryByTestId('verdict-consequence')).toBeNull();
  });

  it('says what will happen once one is chosen, before anything moves', () => {
    const copy = consequenceCopy({ verdict: 'PROCEED', consequence: CONSEQUENCE, candidate: 'Arjun Mehta', letterWaiting: false });
    panel({ verdict: 'PROCEED', copy, reason: 'Clear on data modelling.', canSubmit: true });
    expect(screen.getByTestId('verdict-consequence').textContent).toContain('move Arjun Mehta to Gold');
  });

  it('names the act on the button rather than calling it "Submit"', () => {
    const copy = consequenceCopy({ verdict: 'PROCEED', consequence: CONSEQUENCE, candidate: 'Arjun Mehta', letterWaiting: false });
    panel({ verdict: 'PROCEED', copy, reason: 'Clear.', canSubmit: true });
    expect(screen.getByTestId('verdict-act').textContent).toContain('Advance to Gold');
  });

  it('carries the whole act on the primary and only the record on the secondary', () => {
    const calls: boolean[] = [];
    const copy = consequenceCopy({ verdict: 'PROCEED', consequence: CONSEQUENCE, candidate: 'Arjun Mehta', letterWaiting: false });
    panel({ verdict: 'PROCEED', copy, reason: 'Clear.', canSubmit: true, onSubmit: (apply: boolean) => calls.push(apply) });

    fireEvent.click(screen.getByTestId('verdict-act'));
    fireEvent.click(screen.getByTestId('verdict-record-only'));

    expect(calls).toEqual([true, false]);
  });

  it('does not offer "Just record it" for Consider, which decides nothing anyway', () => {
    const copy = consequenceCopy({
      verdict: 'CONSIDER', candidate: 'Arjun Mehta', letterWaiting: false,
      consequence: { ...CONSEQUENCE, verdict: 'CONSIDER' },
    });
    panel({ verdict: 'CONSIDER', copy, reason: 'Want a second read.', canSubmit: true });
    expect(screen.queryByTestId('verdict-record-only')).toBeNull();
  });

  it('cannot be submitted without a reason', () => {
    const copy = consequenceCopy({ verdict: 'PROCEED', consequence: CONSEQUENCE, candidate: 'Arjun Mehta', letterWaiting: false });
    panel({ verdict: 'PROCEED', copy, reason: '', canSubmit: false });
    expect(screen.getByTestId('verdict-act').hasAttribute('disabled')).toBe(true);
  });

  // The blind-review rule: the AI's reading waits until the reviewer has
  // recorded their own. The control itself stays available.
  it('withholds the AI reading where the organisation asks for a blind read first', () => {
    panel({ ai: null });
    expect(screen.queryByTestId('verdict-ai')).toBeNull();
    expect(screen.getByTestId('verdict-ai-withheld').textContent).toContain('Withheld');
  });

  it('says plainly when the decision is not this reader\'s to make', () => {
    panel({ refusal: 'Only a hiring manager, a reviewer or an admin can record a review.' });
    expect(screen.getByTestId('verdict-refusal').textContent).toContain('Only a hiring manager');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The evidence, and the turn it points at
// ---------------------------------------------------------------------------

const SKILLS: SkillView[] = [
  {
    id: 'failure', name: 'Failure handling', level: 3, requiredLevel: 3, notEnoughEvidence: false,
    rationale: 'Reasons from the outage backwards.',
    evidence: [{ turnId: 'turn-7', startMs: 1_325_000, quote: 'retries were the outage' }],
  },
  {
    id: 'leading', name: 'Leading a team', level: null, requiredLevel: 3, notEnoughEvidence: true,
    rationale: '', evidence: [],
  },
];

describe('the skills grid', () => {
  it('shows each quote as a chip with the moment it was said', () => {
    render(h(SkillsGrid, { skills: SKILLS, activeChip: '', onChip: () => undefined }));
    expect(screen.getByTestId('evidence-chip').textContent).toContain('22:05');
  });

  it('hands the chip its turn, so the transcript is found by id and not by matching text', () => {
    const seen: { key: string; turnId: string }[] = [];
    render(h(SkillsGrid, { skills: SKILLS, activeChip: '', onChip: (c: { key: string; turnId: string }) => seen.push(c) }));

    fireEvent.click(screen.getByTestId('evidence-chip'));

    expect(seen.map((c) => c.turnId)).toEqual(['turn-7']);
  });

  it('marks the chosen chip as pressed', () => {
    render(h(SkillsGrid, { skills: SKILLS, activeChip: 'turn-7-0', onChip: () => undefined }));
    expect(screen.getByTestId('evidence-chip').getAttribute('aria-pressed')).toBe('true');
  });

  it('says a competency was not reached rather than scoring it zero', () => {
    render(h(SkillsGrid, { skills: SKILLS, activeChip: '', onChip: () => undefined }));
    expect(screen.getByText('Not enough evidence')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The transcript alongside
// ---------------------------------------------------------------------------

const ROWS: TranscriptRow[] = [
  { key: '0', turnId: 'turn-6', voice: 'interviewer', label: 'Avery', text: 'Tell me about an outage.', stamp: '21:10', competency: 'Failure handling', leftByButton: false },
  { key: '1', turnId: 'turn-7', voice: 'candidate', label: 'Arjun', text: 'Our retries were the outage.', stamp: '22:05', competency: null, leftByButton: false },
];

function transcript(over: Record<string, unknown> = {}) {
  return render(h(AssessmentTranscript, {
    status: 'ready', rows: ROWS, error: '', onRetry: () => undefined,
    quotedTurnId: '', quotedAt: 0, transcriptKey: 'k', onRead: () => undefined, ...over,
  } as never));
}

describe('the transcript column', () => {
  it('marks the quoted turn, and only that one', () => {
    transcript({ quotedTurnId: 'turn-7' });
    const marked = screen.getAllByTestId('transcript-turn').filter((t) => t.className.includes('is-quoted'));
    expect(marked.map((t) => t.getAttribute('data-turn-id'))).toEqual(['turn-7']);
  });

  // The mark has to survive being read aloud, so it is a word as well as a rule.
  it('says "quoted" in words, not only as a colour', () => {
    transcript({ quotedTurnId: 'turn-7' });
    expect(screen.getByText('[ quoted ]')).toBeTruthy();
  });

  it('marks nothing until a chip is pressed', () => {
    transcript();
    expect(screen.getAllByTestId('transcript-turn').some((t) => t.className.includes('is-quoted'))).toBe(false);
  });

  // The whole point of the column: the skill being read must stay on screen
  // while its evidence is checked, so the page itself never moves.
  it('scrolls its own column and leaves the page where it was', () => {
    const pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    // Not present in the test DOM, so it is installed before it is watched:
    // the point is that the component never reaches for it.
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
    const intoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const { container, rerender } = transcript();
    const body = container.querySelector('.tx-body') as HTMLElement;
    const columnScroll = vi.fn();
    body.scrollTo = columnScroll as unknown as HTMLElement['scrollTo'];

    rerender(h(AssessmentTranscript, {
      status: 'ready', rows: ROWS, error: '', onRetry: () => undefined,
      quotedTurnId: 'turn-7', quotedAt: 1, transcriptKey: 'k', onRead: () => undefined,
    } as never));

    expect(columnScroll).toHaveBeenCalledTimes(1);
    expect([pageScroll.mock.calls.length, intoView.mock.calls.length]).toEqual([0, 0]);
    pageScroll.mockRestore();
    intoView.mockRestore();
  });

  it('brings the turn back into view when the same chip is pressed again', () => {
    const { container, rerender } = transcript();
    const body = container.querySelector('.tx-body') as HTMLElement;
    const columnScroll = vi.fn();
    body.scrollTo = columnScroll as unknown as HTMLElement['scrollTo'];
    const press = (quotedAt: number) => rerender(h(AssessmentTranscript, {
      status: 'ready', rows: ROWS, error: '', onRetry: () => undefined,
      quotedTurnId: 'turn-7', quotedAt, transcriptKey: 'k', onRead: () => undefined,
    } as never));

    press(1);
    press(2);

    expect(columnScroll).toHaveBeenCalledTimes(2);
  });

  it('offers a way back when the transcript could not be loaded', () => {
    const retries: number[] = [];
    transcript({ status: 'failed', rows: [], error: 'Network is down.', onRetry: () => retries.push(1) });
    fireEvent.click(screen.getByText('Try again'));
    expect(retries.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// What folds underneath
// ---------------------------------------------------------------------------

describe('the folded readings', () => {
  it('keeps strengths and concerns on the page, but out of the way', () => {
    render(h(SwotFold, { result: { strengths: ['Reasons from failure first'], concerns: ['Loose estimates'] } }));
    const fold = screen.getByTestId('swot-fold') as HTMLDetailsElement;
    expect([fold.open, fold.textContent?.includes('2 points')]).toEqual([false, true]);
  });

  it('opens to the points themselves', () => {
    render(h(SwotFold, { result: { strengths: ['Reasons from failure first'] } }));
    expect(screen.getByText('Reasons from failure first')).toBeTruthy();
  });

  it('is absent entirely when there is nothing to fold', () => {
    const { container } = render(h(SwotFold, { result: { strengths: [], concerns: [] } }));
    expect(container.innerHTML).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The whole control, driven as a reviewer drives it
// ---------------------------------------------------------------------------

function Harness() {
  const [verdict, setVerdict] = useState<'' | 'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS'>('');
  const [reason, setReason] = useState('');
  // What the server would send for a candidate at Silver whose interview has
  // just been reviewed: reviewing it assesses it, so every verdict carries them
  // to Gold, and Do not progress then ends the journey there.
  const consequence = verdict === '' ? null : {
    ...CONSEQUENCE,
    verdict,
    closes: verdict === 'DO_NOT_PROGRESS' ? 'REJECTED' : null,
  };
  const copy = verdict === '' || !consequence
    ? null
    : consequenceCopy({ verdict, consequence, candidate: 'Arjun Mehta', letterWaiting: true });
  return h(VerdictPanel, {
    ai: { recommendation: 'PROCEED', confidence: 0.8, caveat: '' },
    candidate: 'Arjun Mehta',
    verdict, onVerdict: setVerdict, reason, onReason: setReason,
    copy, canSubmit: verdict !== '' && reason.trim().length >= 3, submitting: false,
    onSubmit: () => undefined, refusal: '',
  } as never);
}

describe('choosing a verdict', () => {
  beforeEach(() => { render(h(Harness)); });

  it('shows its consequence straight away', () => {
    fireEvent.click(screen.getByTestId('verdict-DO_NOT_PROGRESS'));
    expect(screen.getByTestId('verdict-consequence').textContent).toContain("end Arjun Mehta's journey at Gold");
  });

  it('warns about the letter that goes out with it', () => {
    fireEvent.click(screen.getByTestId('verdict-DO_NOT_PROGRESS'));
    expect(screen.getByTestId('verdict-consequence').textContent).toContain('feedback letter is waiting');
  });

  it('changes its mind when the reviewer does', () => {
    fireEvent.click(screen.getByTestId('verdict-DO_NOT_PROGRESS'));
    fireEvent.click(screen.getByTestId('verdict-PROCEED'));
    expect(screen.getByTestId('verdict-consequence').textContent).toContain('move Arjun Mehta to Gold');
  });

  it('stays unsubmittable until a reason is typed', () => {
    fireEvent.click(screen.getByTestId('verdict-PROCEED'));
    expect(screen.getByTestId('verdict-act').hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Why (required)'), { target: { value: 'Strong on load.' } });

    expect(screen.getByTestId('verdict-act').hasAttribute('disabled')).toBe(false);
  });
});
