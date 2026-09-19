import { describe, it, expect } from 'vitest';
import {
  interviewStatus, pipelineStatus, decisionStatus, roundStatus, recommendationStatus, toneToBadgeKind,
} from '../src/components/statusModel';
// Imported from the server's own state machine rather than copied, so adding a
// state there and forgetting a badge here genuinely fails this test. A copy
// could never do that: it would simply agree with itself.
import { SESSION_STATES, EXCEPTION_STATES } from '../../server/src/domain/stateMachine';

describe('interviewStatus', () => {
  it('gives every known session and exception state a non-neutral tone', () => {
    const neutral = [...SESSION_STATES, ...EXCEPTION_STATES].filter((s) => interviewStatus(s).tone === 'neutral');
    expect(neutral).toEqual([]);
  });

  it('gives every known state a label that is not the raw constant', () => {
    const shouty = [...SESSION_STATES, ...EXCEPTION_STATES].filter((s) => interviewStatus(s).label === s);
    expect(shouty).toEqual([]);
  });

  it('uses a distinct icon for review-ready interviews', () => {
    expect(interviewStatus('REVIEW_READY')).toEqual({ label: 'Review ready', tone: 'pass', icon: 'evidence' });
  });

  it('marks cancelled interviews as stopped with a cross icon', () => {
    expect(interviewStatus('CANCELLED')).toEqual({ label: 'Cancelled', tone: 'stop', icon: 'x-circle' });
  });

  it('marks an invited interview as on hold with a mail icon', () => {
    expect(interviewStatus('INVITED')).toEqual({ label: 'Invited', tone: 'hold', icon: 'mail' });
  });

  it('keeps the existing colour grouping for technical failures', () => {
    expect(interviewStatus('TECHNICAL_FAILURE').tone).toBe('stop');
  });

  it('shows pre-interview setup states as informational', () => {
    expect(interviewStatus('READY_CHECK').tone).toBe('info');
  });

  it('falls back to a neutral, readable label for an unknown state', () => {
    expect(interviewStatus('SOMETHING_NEW')).toEqual({ label: 'Something new', tone: 'neutral', icon: 'about' });
  });
});

// A chip with no text has no accessible name, so a screen reader announces
// nothing at all where a status should be.
describe('a missing or blank status', () => {
  it('still produces a readable label for an empty string', () => {
    expect(interviewStatus('')).toEqual({ label: 'Unknown', tone: 'neutral', icon: 'about' });
  });

  it('still produces a readable label for whitespace', () => {
    expect(interviewStatus('   ')).toEqual({ label: 'Unknown', tone: 'neutral', icon: 'about' });
  });

  it('applies to every status family, not just interviews', () => {
    expect([pipelineStatus(''), decisionStatus(''), roundStatus(''), recommendationStatus('')].map((s) => s.label))
      .toEqual(['Unknown', 'Unknown', 'Unknown', 'Unknown']);
  });
});

describe('pipelineStatus', () => {
  it('shows an active pipeline as informational', () => {
    expect(pipelineStatus('ACTIVE')).toEqual({ label: 'Active', tone: 'info', icon: 'play' });
  });

  it('shows a decided pipeline as neutral with a check icon', () => {
    expect(pipelineStatus('DECIDED')).toEqual({ label: 'Decided', tone: 'neutral', icon: 'check-circle' });
  });
});

describe('decisionStatus', () => {
  it('shows an approval as a pass', () => {
    expect(decisionStatus('APPROVED')).toEqual({ label: 'Approved', tone: 'pass', icon: 'check-circle' });
  });

  it('describes a rejection without the word rejected', () => {
    expect(decisionStatus('REJECTED')).toEqual({ label: 'Not progressing', tone: 'stop', icon: 'x-circle' });
  });

  it('shows a withdrawal as neutral', () => {
    expect(decisionStatus('WITHDRAWN')).toEqual({ label: 'Withdrawn', tone: 'neutral', icon: 'sign-out' });
  });
});

describe('roundStatus', () => {
  it('shows a scheduled round with a calendar icon', () => {
    expect(roundStatus('SCHEDULED')).toEqual({ label: 'Scheduled', tone: 'info', icon: 'schedule' });
  });

  it('shows a completed round as a pass', () => {
    expect(roundStatus('COMPLETED').tone).toBe('pass');
  });

  it('shows a cancelled round as stopped', () => {
    expect(roundStatus('CANCELLED').tone).toBe('stop');
  });
});

describe('recommendationStatus', () => {
  it('maps DO_NOT_PROGRESS to a stop tone', () => {
    expect(recommendationStatus('DO_NOT_PROGRESS')).toEqual({ label: 'Do not progress', tone: 'stop', icon: 'x-circle' });
  });
});

describe('toneToBadgeKind', () => {
  it('maps tones onto the existing badge colour classes', () => {
    expect(['pass', 'hold', 'stop', 'info', 'neutral'].map((t) => toneToBadgeKind(t as never)))
      .toEqual(['green', 'amber', 'red', 'blue', 'gray']);
  });
});
