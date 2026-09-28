import { useEffect, useMemo, useRef } from 'react';
import {
  browserTimeZone, initialTimeZone, listTimeZones, schedulePreview, timeZoneOptionLabel, type ScheduleDraft,
} from './zonedScheduleModel';
import { candidateZoneUnsetNotice, effectiveOrgTimeZone } from './orgTimeZone';

export const EMPTY_SCHEDULE: ScheduleDraft = { timeZone: '', date: '', time: '' };

interface Props {
  readonly idPrefix: string;
  readonly value: ScheduleDraft;
  readonly onChange: (next: ScheduleDraft) => void;
  /** The organisation's zone; undefined while it loads. */
  readonly orgZone: string | null | undefined;
  /**
   * Where the candidate is, for a booking that is about one. Omitted entirely
   * where the booking is not about a particular candidate.
   *
   * `loaded` is not decoration. The organisation's zone and the candidate's
   * arrive from two different requests, and this field is filled once; a bare
   * `string | null` cannot tell "HR recorded nothing" from "the answer has not
   * come back yet", so whenever the organisation's landed first the picker
   * settled on it and ignored the candidate's when it arrived. That is the
   * silent substitution this whole area exists to stop, reappearing as a race.
   */
  readonly candidate?: { readonly timeZone: string | null; readonly loaded: boolean };
  readonly disabled?: boolean;
  /** Hides the labels for a compact inline form; they stay for screen readers. */
  readonly compact?: boolean;
}

/**
 * Time zone first, then the date, then the time, and what that means in words
 * underneath. The zone is asked first because it decides what the rest means:
 * a datetime-local field silently used the recruiter's own clock.
 *
 * The zone field is a type-ahead over every zone the browser knows, starting
 * on the organisation's zone (IST when it has none).
 */
export function TimeZoneDateTimePicker({ idPrefix, value, onChange, orgZone, candidate, disabled = false, compact = false }: Props) {
  const zones = useMemo(() => {
    const now = new Date();
    return listTimeZones().map((zone) => ({ zone, offset: timeZoneOptionLabel(zone, now) }));
  }, []);
  const viewerZone = browserTimeZone();

  // Filled once, when the organisation's zone is known. Only once: someone
  // clearing the field to search must not have it refilled under them.
  //
  // The candidate's zone wins where there is one: the owner's rule is that HR
  // records where the candidate is and interviews are booked on that clock.
  // Where there is not, the organisation's stands in — and the notice below
  // says it is standing in.
  //
  // It waits for BOTH answers where a candidate is involved. Filling on the
  // first to arrive is what let the organisation's zone win a race it should
  // never have been in.
  const answersIn = orgZone !== undefined && (candidate === undefined || candidate.loaded);
  const suggested = useRef(false);
  useEffect(() => {
    if (suggested.current || !answersIn) return;
    suggested.current = true;
    if (!value.timeZone) onChange({ ...value, timeZone: candidate?.timeZone ?? initialTimeZone(orgZone) });
  }, [answersIn, orgZone, candidate, value, onChange]);

  // Only once we know there is nothing to fall back FROM: a booking that is
  // not about a candidate has nothing to say here, and one whose answer is
  // still coming must not accuse HR of having left it blank.
  const substituting = answersIn && candidate !== undefined && candidate.timeZone === null;

  const preview = schedulePreview(value, new Date(), viewerZone);
  const labelClass = compact ? 'visually-hidden' : undefined;
  const listId = `${idPrefix}-zones`;

  return (
    <div className="tz-picker" data-testid={`${idPrefix}-picker`}>
      {substituting && (
        <p className="muted small" data-testid={`${idPrefix}-candidate-zone-unset`}>
          {candidateZoneUnsetNotice(effectiveOrgTimeZone(orgZone))}
        </p>
      )}
      <label className={labelClass} htmlFor={`${idPrefix}-zone`}>Time zone</label>
      <input
        id={`${idPrefix}-zone`}
        list={listId}
        value={value.timeZone}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        placeholder="Type a city, e.g. Kolkata"
        onChange={(e) => onChange({ ...value, timeZone: e.target.value.trim() })}
        aria-describedby={`${idPrefix}-preview`}
        required
      />
      <datalist id={listId}>
        {zones.map(({ zone, offset }) => <option key={zone} value={zone} label={offset} />)}
      </datalist>
      <div className="row" style={{ gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label className={labelClass} htmlFor={`${idPrefix}-date`}>Date</label>
          <input id={`${idPrefix}-date`} type="date" value={value.date} disabled={disabled} required
            onChange={(e) => onChange({ ...value, date: e.target.value })} />
        </div>
        <div style={{ flex: 1 }}>
          <label className={labelClass} htmlFor={`${idPrefix}-time`}>Time</label>
          <input id={`${idPrefix}-time`} type="time" value={value.time} disabled={disabled} required
            onChange={(e) => onChange({ ...value, time: e.target.value })} />
        </div>
      </div>
      <p
        id={`${idPrefix}-preview`}
        className={preview.kind === 'problem' ? 'field-hint field-problem' : 'field-hint'}
        aria-live="polite"
        data-testid={`${idPrefix}-preview`}
      >
        {preview.kind === 'ok' ? `= ${preview.text}` : preview.kind === 'problem' ? preview.text : 'Pick the time zone, then the date and time.'}
      </p>
    </div>
  );
}

/** The picked time can be sent: complete, real, and still ahead. */
export function isSchedulable(draft: ScheduleDraft): boolean {
  return schedulePreview(draft, new Date(), browserTimeZone()).kind === 'ok';
}
