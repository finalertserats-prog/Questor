import { describe, expect, it } from 'vitest';
import { candidateNextAction, interviewNextAction, roleNextAction } from '../src/components/listCardModel';

const candidate = (state: string | null) => ({ id: 'c1', latestInterview: state ? { id: 'i1', state } : null });
const session = (state: string, assessmentId: string | null = null, blindReviewPending = false) => ({ id: 'i1', state, assessmentId, blindReviewPending });

describe('candidateNextAction', () => {
  it('asks for an interview when there is none', () => {
    expect(candidateNextAction(candidate(null))).toEqual({ label: 'Set up an interview', to: '/candidates/c1?tab=journey' });
  });

  it('points at the review when the interview is ready for one', () => {
    expect(candidateNextAction(candidate('REVIEW_READY'))).toMatchObject({ label: 'Review the interview', mark: 'review' });
  });

  it('marks a stopped interview as needing a look', () => {
    expect(candidateNextAction(candidate('NO_SHOW')).mark).toBe('urgent');
  });

  it('marks an unstarted invitation as waiting on the candidate', () => {
    expect(candidateNextAction(candidate('INVITED')).mark).toBe('waiting');
  });

  it('marks an interview under way as live', () => {
    expect(candidateNextAction(candidate('ASSESSING')).mark).toBe('live');
  });

  it('leaves a finished, reviewed interview unmarked', () => {
    expect(candidateNextAction(candidate('HUMAN_REVIEWED'))).toEqual({ label: 'Open candidate', to: '/candidates/c1' });
  });
});

describe('interviewNextAction', () => {
  it('opens the assessment once there is one', () => {
    expect(interviewNextAction(session('HUMAN_REVIEWED', 'a1'))).toEqual({ label: 'View assessment', to: '/assessments/a1', mark: undefined });
  });

  it('sends a reviewer held back by blind review to their own review first', () => {
    expect(interviewNextAction(session('REVIEW_READY', 'a1', true)).to).toBe('/assessments/a1/review');
  });

  it('marks a stopped interview', () => {
    expect(interviewNextAction(session('TECHNICAL_FAILURE')).mark).toBe('urgent');
  });

  it('opens the interview otherwise', () => {
    expect(interviewNextAction(session('CLOSED'))).toEqual({ label: 'Open interview', to: '/interviews/i1' });
  });
});

describe('roleNextAction', () => {
  it('counts interviews waiting for review', () => {
    expect(roleNextAction({ id: 'r1', awaitingReview: 2 }).label).toBe('2 interviews to review');
  });

  it('opens the role when nothing waits', () => {
    expect(roleNextAction({ id: 'r1', awaitingReview: 0 })).toEqual({ label: 'Open role', to: '/roles/r1' });
  });
});
