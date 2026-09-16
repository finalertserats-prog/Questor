/**
 * The pure search rules behind the organisation picker. Kept out of React so
 * the frugal-fetch and stale-response behaviour can be tested in node.
 */

export interface Org {
  readonly name: string;
  readonly slug: string;
}

export type OrgSearchStatus = 'idle' | 'ready' | 'loading' | 'rate-limited';

export interface OrgSearchState {
  readonly query: string;
  readonly lastRequestedQuery: string | null;
  readonly latestRequestId: number;
  readonly results: readonly Org[];
  readonly status: OrgSearchStatus;
}

export interface OrgSearchRequest {
  readonly query: string;
  readonly requestId: number;
}

export interface OrgSearchUpdate {
  readonly state: OrgSearchState;
  readonly request: OrgSearchRequest | null;
}

export const ORG_SEARCH_MIN_CHARS = 3;

export function initialOrgSearchState(): OrgSearchState {
  return {
    query: '',
    lastRequestedQuery: null,
    latestRequestId: 0,
    results: [],
    status: 'idle',
  };
}

export function orgSearchPath(org: Org): string {
  return `/o/${org.slug}`;
}

export function planOrgSearch(state: OrgSearchState, rawQuery: string): OrgSearchUpdate {
  const query = rawQuery.trim();
  if (query.length < ORG_SEARCH_MIN_CHARS) {
    return {
      state: {
        ...state,
        query,
        status: 'idle',
      },
      request: null,
    };
  }

  if (state.lastRequestedQuery === query) {
    return {
      state: {
        ...state,
        query,
      },
      request: null,
    };
  }

  const requestId = state.latestRequestId + 1;
  return {
    state: {
      ...state,
      query,
      lastRequestedQuery: query,
      latestRequestId: requestId,
      status: 'loading',
    },
    request: { query, requestId },
  };
}

export function receiveOrgSearchResults(
  state: OrgSearchState,
  requestId: number,
  orgs: readonly Org[],
): OrgSearchState {
  if (requestId !== state.latestRequestId) return state;
  return {
    ...state,
    results: [...orgs],
    status: 'ready',
  };
}

export function keepOrgSearchResultsAfterRateLimit(state: OrgSearchState, requestId: number): OrgSearchState {
  if (requestId !== state.latestRequestId) return state;
  return {
    ...state,
    status: 'rate-limited',
  };
}

/**
 * A request that failed for any reason other than being told to slow down: a
 * dropped connection, a server error. That is not "no such organisation", so
 * nothing is shown, and the query is forgotten so that the next keystroke, or
 * the same text typed again, asks again instead of being skipped as a repeat.
 */
export function forgetFailedOrgSearch(state: OrgSearchState, requestId: number): OrgSearchState {
  if (requestId !== state.latestRequestId) return state;
  return {
    ...state,
    lastRequestedQuery: null,
    results: [],
    status: 'idle',
  };
}
