import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { aiCallCell } from '../src/components/ui';

/**
 * When the organisation requires an independent review first, the server
 * leaves the AI's call out for a reviewer who has not judged yet. The list
 * cells say so in words rather than showing a dash, which reads as "no
 * assessment".
 */

describe('the AI call in a list cell', () => {
  it('says the reviewer judges first when the call is withheld', () => {
    const markup = renderToStaticMarkup(aiCallCell({ blindReviewPending: true }));
    expect(markup).toContain('Your review first');
  });

  it('shows no recommendation when the call is withheld', () => {
    const markup = renderToStaticMarkup(aiCallCell({ blindReviewPending: true }));
    expect(markup).not.toContain('unvalidated score');
  });

  it('shows the recommendation when there is one', () => {
    const markup = renderToStaticMarkup(aiCallCell({ recommendation: 'PROCEED' }));
    expect(markup).toContain('unvalidated score');
  });

  it('shows a dash when there is no assessment and nothing is withheld', () => {
    const markup = renderToStaticMarkup(aiCallCell({ recommendation: null }));
    expect(markup).toContain('—');
  });
});
