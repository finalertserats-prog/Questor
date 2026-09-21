import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client';
import { clampActiveOption } from './catalogModel';
import { isSearchable, roleEntryLabel, type CandidatePerson } from './candidateReuseModel';

/**
 * The Full name field on Add candidate, doubling as a search for people
 * already in Questor. Typing stays free text; picking a match hands the
 * person to the page, which then sets them up for the role rather than
 * creating a second, retyped record.
 */
export function CandidatePersonCombobox(props: {
  readonly value: string;
  readonly inputId: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
  readonly onPick: (person: CandidatePerson) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<readonly CandidatePerson[]>([]);
  const [active, setActive] = useState(0);
  const requestSeq = useRef(0);
  const activeIndex = clampActiveOption(active, people.length);

  useEffect(() => {
    // Bumped before the early return too, so an answer to an older query never lands.
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    if (props.disabled || !isSearchable(props.value)) {
      setPeople([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const qs = new URLSearchParams({ q: props.value.trim() });
      api.get<{ people: CandidatePerson[] }>(`/candidates/search?${qs.toString()}`, { signal: controller.signal })
        .then((d) => { if (requestSeq.current === seq) setPeople(d.people ?? []); })
        // A failed search only means no suggestions; the field still takes a new person.
        .catch(() => { if (requestSeq.current === seq) setPeople([]); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [props.value, props.disabled]);

  const pick = (person: CandidatePerson | undefined) => {
    if (!person) return;
    setOpen(false);
    props.onPick(person);
  };

  const showList = open && people.length > 0;

  return (
    <div
      style={{ position: 'relative' }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <input
        id={props.inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={`${id}-list`}
        aria-activedescendant={showList ? `${id}-opt-${activeIndex}` : undefined}
        autoComplete="off"
        disabled={props.disabled}
        value={props.value}
        onChange={(e) => { props.onChange(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(clampActiveOption(activeIndex + 1, people.length)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive(clampActiveOption(activeIndex - 1, people.length)); }
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && showList) { e.preventDefault(); pick(people[activeIndex]); }
        }}
        required
      />
      {showList && (
        <div id={`${id}-list`} role="listbox" aria-label="People already in Questor" className="card combobox-list" style={{ position: 'absolute', zIndex: 20, width: '100%', marginTop: 4, padding: 6 }}>
          <div className="muted small" style={{ padding: '2px 8px 6px' }}>Already in Questor</div>
          {people.map((person, index) => (
            <button
              key={person.candidateId}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={activeIndex === index}
              type="button"
              className="link-button combobox-option"
              style={{ display: 'block', padding: 6, textAlign: 'left', width: '100%' }}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(person)}
            >
              <span>{person.fullName}</span> <span className="muted small">{person.email}</span><br />
              <span className="muted small">
                In: {person.roles.map(roleEntryLabel).join(', ')}{person.hasResume ? ' · resume on file' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
