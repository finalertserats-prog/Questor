import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError } from '../api/client';
import {
  initialOrgSearchState,
  keepOrgSearchResultsAfterRateLimit,
  planOrgSearch,
  receiveOrgSearchResults,
  type Org,
  type OrgSearchRequest,
  type OrgSearchState,
} from './orgSearchModel';

interface OrgPickerProps {
  readonly onChoose: (org: Org) => void;
}

async function fetchOrgs(query: string): Promise<readonly Org[]> {
  const data = await api.get<{ orgs: Org[] }>(`/orgs?q=${encodeURIComponent(query)}`);
  return data.orgs;
}

export function OrgPicker({ onChoose }: OrgPickerProps) {
  const inputId = useId();
  const listboxId = useId();
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState<OrgSearchState>(() => initialOrgSearchState());
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchRef = useRef(search);

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  const startRequest = (request: OrgSearchRequest) => {
    fetchOrgs(request.query)
      .then((orgs) => {
        if (request.requestId !== searchRef.current.latestRequestId) return;
        setSearch((current) => receiveOrgSearchResults(current, request.requestId, orgs));
        setOpen(true);
        setActiveIndex(orgs.length > 0 ? 0 : -1);
      })
      .catch((error: unknown) => {
        if (request.requestId !== searchRef.current.latestRequestId) return;
        setSearch((current) => {
          if (error instanceof ApiError && error.status === 429) {
            return keepOrgSearchResultsAfterRateLimit(current, request.requestId);
          }
          return { ...current, results: [], status: 'ready' };
        });
        setOpen(error instanceof ApiError && error.status === 429 ? searchRef.current.results.length > 0 : true);
        setActiveIndex(-1);
      });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const update = planOrgSearch(searchRef.current, typed);
      setSearch(update.state);
      if (update.request) startRequest(update.request);
      if (update.state.results.length === 0) setActiveIndex(-1);
      setOpen(update.state.query.length >= 3);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [typed]);

  const results = search.results;
  const activeId = activeIndex >= 0 && activeIndex < results.length ? `${listboxId}-${activeIndex}` : undefined;
  const showList = open && results.length > 0;
  const showEmpty = open && search.status === 'ready' && search.query.length >= 3 && results.length === 0;

  const choose = (org: Org) => {
    setTyped(org.name);
    setOpen(false);
    setActiveIndex(-1);
    onChoose(org);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (!showList) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? results.length - 1 : current - 1));
    } else if (event.key === 'Enter' && activeIndex >= 0 && activeIndex < results.length) {
      event.preventDefault();
      choose(results[activeIndex]);
    }
  };

  return (
    <div className="org-picker">
      <label htmlFor={inputId}>Your organisation</label>
      <input
        id={inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (search.query.length >= 3) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder="Acme Corp"
        autoComplete="organization"
      />
      {showList && (
        <ul className="org-picker-list" id={listboxId} role="listbox">
          {results.map((org, index) => (
            <li
              id={`${listboxId}-${index}`}
              key={org.slug}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? 'org-picker-option is-active' : 'org-picker-option'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(org)}
            >
              <span>{org.name}</span>
              <span className="muted small">/o/{org.slug}</span>
            </li>
          ))}
        </ul>
      )}
      {showEmpty && (
        <p className="field-hint org-picker-empty">
          We can't find that organisation. Check the spelling, or use the sign-in link your organisation shared.
        </p>
      )}
    </div>
  );
}
