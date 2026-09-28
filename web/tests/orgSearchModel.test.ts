import { describe, expect, it } from 'vitest';
import {
  forgetFailedOrgSearch,
  initialOrgSearchState,
  keepOrgSearchResultsAfterRateLimit,
  orgSearchPath,
  planOrgSearch,
  receiveOrgSearchResults,
} from '../src/components/orgSearchModel';

describe('planOrgSearch', () => {
  it('does not request anything before the trimmed query has three characters', () => {
    // Arrange
    const state = initialOrgSearchState();

    // Act
    const update = planOrgSearch(state, '  ac  ');

    // Assert
    expect(update.request).toBeNull();
  });

  it('skips an identical query that has already been requested', () => {
    // Arrange
    const first = planOrgSearch(initialOrgSearchState(), 'acm').state;

    // Act
    const second = planOrgSearch(first, 'acm');

    // Assert
    expect(second.request).toBeNull();
  });
});

describe('receiveOrgSearchResults', () => {
  it('ignores a response when a newer request is already active', () => {
    // Arrange
    const first = planOrgSearch(initialOrgSearchState(), 'acm').state;
    const second = planOrgSearch(first, 'acme').state;

    // Act
    const state = receiveOrgSearchResults(second, 1, [{ name: 'Acme Corp', slug: 'acme' }]);

    // Assert
    expect(state.results).toEqual([]);
  });

  it('keeps the current results when the latest request is rate limited', () => {
    // Arrange
    const searched = planOrgSearch(initialOrgSearchState(), 'acm').state;
    const ready = receiveOrgSearchResults(searched, 1, [{ name: 'Acme Corp', slug: 'acme' }]);
    const next = planOrgSearch(ready, 'acme').state;

    // Act
    const state = keepOrgSearchResultsAfterRateLimit(next, 2);

    // Assert
    expect(state.results).toEqual([{ name: 'Acme Corp', slug: 'acme' }]);
  });
});

describe('forgetFailedOrgSearch', () => {
  it('lets the same query be asked again after a failure instead of skipping it as a repeat', () => {
    // Arrange
    const searched = planOrgSearch(initialOrgSearchState(), 'acm').state;
    const failed = forgetFailedOrgSearch(searched, 1);

    // Act
    const retry = planOrgSearch(failed, 'acm');

    // Assert
    expect(retry.request).not.toBeNull();
  });

  it('does not show the not-found message for a query that merely failed to send', () => {
    // Arrange
    const searched = planOrgSearch(initialOrgSearchState(), 'acm').state;

    // Act
    const state = forgetFailedOrgSearch(searched, 1);

    // Assert
    expect(state.status).toBe('idle');
  });
});

describe('orgSearchPath', () => {
  it('maps a chosen organisation to its sign-in path', () => {
    // Arrange
    const org = { name: 'Acme Corp', slug: 'acme-hiring' };

    // Act
    const path = orgSearchPath(org);

    // Assert
    expect(path).toBe('/o/acme-hiring');
  });
});
