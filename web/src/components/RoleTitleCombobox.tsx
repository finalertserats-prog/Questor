import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { clampActiveOption, newRoleLabel, shouldOfferNewRole, isCurrentQuery, type TypeaheadQuery } from './catalogModel';

export interface CatalogRoleOption {
  readonly id: string;
  readonly title: string;
  readonly domain: { readonly id: string; readonly name: string };
  readonly family: string | null;
  readonly marketSignal: string;
  readonly matchedAlias: string | null;
}

interface RolesResponse { readonly exact: boolean; readonly roles: readonly CatalogRoleOption[] }
interface CreateResponse { readonly role: CatalogRoleOption }

export function RoleTitleCombobox(props: {
  readonly domainId: string;
  readonly domainName: string;
  readonly value: string;
  readonly techStack: readonly string[];
  readonly disabled?: boolean;
  readonly inputId?: string;
  readonly onTitleChange: (value: string) => void;
  readonly onSelect: (role: CatalogRoleOption) => void;
  readonly onNotice: (message: string) => void;
  /** A failure, shown as an error rather than as information. */
  readonly onError: (message: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RolesResponse>({ exact: false, roles: [] });
  const [active, setActive] = useState(0);
  const requestSeq = useRef(0);
  const offerNew = shouldOfferNewRole(props.value, result) && Boolean(props.domainId);
  const optionsCount = result.roles.length + (offerNew ? 1 : 0);
  // Results can shrink under the highlight; the active option always exists.
  const activeIndex = clampActiveOption(active, optionsCount);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close when a click or tap lands anywhere outside the field and its list.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // What the input asks for right now, read by responses that arrive late.
  const currentQuery = useRef<TypeaheadQuery>({ domainId: props.domainId, value: props.value });
  currentQuery.current = { domainId: props.domainId, value: props.value };

  useEffect(() => {
    // Bumped before the early return too, so a request still in flight when the
    // input is cleared or the domain changes can never land afterwards.
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    if (props.disabled || !props.domainId || props.value.trim().length < 1) {
      setResult({ exact: false, roles: [] });
      setLoading(false);
      return undefined;
    }
    const askedFor: TypeaheadQuery = { domainId: props.domainId, value: props.value };
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const qs = new URLSearchParams({ domainId: props.domainId, q: props.value, limit: '10' });
      api.get<RolesResponse>(`/catalog/roles?${qs.toString()}`, { signal: controller.signal })
        .then((data) => { if (requestSeq.current === seq && isCurrentQuery(askedFor, currentQuery.current)) setResult(data); })
        .catch(() => { if (requestSeq.current === seq) setResult({ exact: false, roles: [] }); })
        .finally(() => { if (requestSeq.current === seq) setLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [props.value, props.domainId, props.disabled]);

  const selectExisting = (role: CatalogRoleOption) => {
    props.onTitleChange(role.title);
    props.onSelect(role);
    setOpen(false);
  };

  const createRole = async () => {
    try {
      const created = await api.post<CreateResponse>('/catalog/roles', { domainId: props.domainId, title: props.value.trim(), techStack: props.techStack });
      selectExisting(created.role);
      props.onNotice('Added to the shared catalog.');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        // Only an exact match is "that role". A retired title has no active
        // match, and the nearest search hit would be a different job.
        const qs = new URLSearchParams({ domainId: props.domainId, q: props.value, limit: '1' });
        const found = await api.get<RolesResponse>(`/catalog/roles?${qs.toString()}`).catch(() => null);
        const first = found?.exact ? found.roles[0] : undefined;
        if (first) {
          selectExisting(first);
          props.onNotice('That role already existed, so it was selected.');
          return;
        }
      }
      props.onError(err instanceof Error ? err.message : 'Could not add that role.');
    }
  };

  const choose = (index: number) => {
    if (offerNew && index === 0) { void createRole(); return; }
    const role = result.roles[index - (offerNew ? 1 : 0)];
    if (role) selectExisting(role);
  };

  return (
    <div
      ref={wrapperRef}
      style={{ position: 'relative' }}
      // Focus moving to anything outside (Tab away) closes the list too.
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <input
        id={props.inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && optionsCount > 0 ? `${id}-opt-${activeIndex}` : undefined}
        disabled={props.disabled}
        value={props.value}
        onChange={(e) => { props.onTitleChange(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(clampActiveOption(activeIndex + 1, optionsCount)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive(clampActiveOption(activeIndex - 1, optionsCount)); }
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && open && optionsCount > 0) { e.preventDefault(); choose(activeIndex); }
        }}
        placeholder={props.disabled ? 'Choose a domain first' : 'Start typing a role title'}
      />
      {open && optionsCount > 0 && (
        <div id={`${id}-list`} role="listbox" className="card combobox-list" style={{ position: 'absolute', zIndex: 20, width: '100%', marginTop: 4, padding: 6 }}>
          {offerNew && <button id={`${id}-opt-0`} role="option" aria-selected={activeIndex === 0} type="button" className="link-button combobox-option" onMouseEnter={() => setActive(0)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(0)}>+ {newRoleLabel(props.value, props.domainName)}</button>}
          {result.roles.map((role, i) => {
            const index = i + (offerNew ? 1 : 0);
            return <button key={role.id} id={`${id}-opt-${index}`} role="option" aria-selected={activeIndex === index} type="button" className="link-button combobox-option" style={{ display: 'block', padding: 6 }} onMouseEnter={() => setActive(index)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(index)}>
              <span>{role.title}</span><br /><span className="muted small">{role.domain.name}{role.family ? ` · ${role.family}` : ''}{role.matchedAlias ? ` · also called ${role.matchedAlias}` : ''}</span>
            </button>;
          })}
          {loading && <div className="muted small">Searching…</div>}
        </div>
      )}
      {/* Said, not left blank: an empty list read as "the field is broken". */}
      {open && optionsCount === 0 && !props.disabled && props.value.trim().length > 0 && (
        <div className="muted small" role="status" style={{ marginTop: 4 }}>
          {loading ? 'Searching…' : 'No matching catalog roles. Keep typing to use your own title.'}
        </div>
      )}
    </div>
  );
}
