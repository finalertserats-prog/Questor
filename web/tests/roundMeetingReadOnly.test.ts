import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoundMeeting } from '../src/components/RoundMeeting';

/**
 * Retrying a meeting and adding a link need interview:schedule on the server.
 * Someone without it (a reviewer, an auditor) was still offered the buttons,
 * and every press ended in a 403. They see the meeting, not the fixes.
 */

const round = {
  id: 'r1', status: 'SCHEDULED', conductedBy: 'HUMAN' as const,
  meeting: { provider: 'zoom', status: 'NEEDS_LINK' as const, url: null, error: 'Zoom could not create the meeting.' },
};

const render = (readOnly: boolean) => renderToStaticMarkup(createElement(RoundMeeting, {
  pipelineId: 'p1', round, busy: false, run: async () => undefined,
  onOutcome: () => undefined, onError: () => undefined, vendorReady: true, readOnly,
}));

describe('a round meeting seen without scheduling rights', () => {
  it('offers no retry', () => {
    expect(render(true)).not.toContain('Try again');
  });

  it('offers no manual link', () => {
    expect(render(true)).not.toContain('Add link manually');
  });

  it('still shows what is wrong with the meeting', () => {
    expect(render(true)).toContain('Zoom could not create the meeting.');
  });
});

describe('a round meeting seen by someone who can schedule', () => {
  it('offers the retry', () => {
    expect(render(false)).toContain('Try again');
  });

  it('offers the manual link', () => {
    expect(render(false)).toContain('Add link manually');
  });
});
