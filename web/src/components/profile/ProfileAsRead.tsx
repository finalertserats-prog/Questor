import { useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { EmptyState } from '../EmptyState';
import {
  documentLineFrom, monthsInWords, profileTabs, readingSummary, redactionWords, roleConcern,
  roleDates, roleState, sourceAvailability, sourceLabel, sourceTitle, splitDocument,
  technologyNote, technologyState,
  type ProfileRead, type ReadEvidence, type ReadState,
} from './profileReadModel';

/**
 * Lane 1: what the CV says, and where it says it.
 *
 * Opened before any role is mentioned, and it never mentions one. The facts
 * here have been parsed and stored since the fit engine was written; no screen
 * ever showed them, so "what does this CV actually contain" had no answer in
 * the product and checking a parse meant reading the CV again.
 *
 * The source tag beside each fact is the point of the screen. It opens the line
 * from the document the candidate uploaded — not the parsed quote — so
 * verifying a fact costs a glance. That is the honest version of "accurate
 * enough that nobody checks": nobody can know a parse is right without looking,
 * so looking is made cheap instead of unnecessary.
 *
 * State is marked with a rule down the leading edge and a bracketed word, never
 * a tinted fill.
 */

const STATE_MARK: Readonly<Record<ReadState, string>> = {
  read: '',
  check: '[ check ]',
  unplaceable: '[ source not recorded ]',
};

function Source({ evidence, lines }: { evidence: ReadEvidence; lines: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const state = sourceAvailability(evidence.sourceLine, lines);
  const original = state === 'ready' ? documentLineFrom(lines, evidence.sourceLine) : null;
  return (
    <>
      <button
        type="button"
        className="par-src"
        aria-expanded={open}
        disabled={state !== 'ready'}
        onClick={() => setOpen((v) => !v)}
        title={sourceTitle(state, evidence.sourceLine)}
      >
        {sourceLabel(evidence)}
      </button>
      {open && original !== null && (
        <p className="par-original">
          <span className="par-lineno">{evidence.sourceLine}</span>
          {original}
          <span className="par-asis">The CV as uploaded, including anything the reading left out.</span>
        </p>
      )}
    </>
  );
}

function Fact({
  state, title, detail, note, evidence, lines,
}: {
  state: ReadState;
  title: string;
  detail?: string | null;
  note?: string | null;
  evidence?: ReadEvidence;
  lines: readonly string[];
}) {
  return (
    <li className={`par-fact par-${state}`}>
      <div className="par-fact-top">
        <span className="par-title">{title}</span>
        {detail && <span className="par-detail">{detail}</span>}
        {STATE_MARK[state] && <span className="par-mark">{STATE_MARK[state]}</span>}
        {evidence && <Source evidence={evidence} lines={lines} />}
      </div>
      {note && <p className="par-note">{note}</p>}
    </li>
  );
}

export function ProfileAsRead({ read, rawText }: { read: ProfileRead | null; rawText: string }) {
  const [tab, setTab] = useState<string>('experience');
  // Split once. Every fact can open its own line, and doing this per fact —
  // then again on each re-render when one is opened — is work proportional to
  // facts times CV size for something the panel needs done once.
  const lines = useMemo(() => splitDocument(rawText), [rawText]);

  if (!read) {
    return (
      <EmptyState
        compact
        icon="resume-upload"
        title="No resume has been read yet"
        message="Upload a CV and Questor reads it into a profile you can check line by line, before any role is involved."
      />
    );
  }

  const tabs = profileTabs(read);

  return (
    <section className="par" aria-label="The profile as read">
      <p className="par-summary">{readingSummary(read)}</p>

      <div className="par-tabs" role="tablist" aria-label="Profile sections">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`par-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`par-panel-${t.key}`}
            className="par-tab"
            onClick={() => setTab(t.key)}
          >
            {t.label}
            <span className="par-count">{t.count}</span>
            {t.needsCheck > 0 && <span className="par-flag" title={`${t.needsCheck} to check`}>·</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="par-panel-experience" aria-labelledby="par-tab-experience" hidden={tab !== 'experience'}>
        {read.roles.length === 0
          ? <p className="par-none">No work history could be read from this CV.</p>
          : (
            <ul className="par-list">
              {read.roles.map((r, i) => (
                <Fact
                  key={`${r.employer}-${i}`}
                  state={roleState(r)}
                  title={`${r.title} · ${r.employer}`}
                  detail={[roleDates(r), monthsInWords(r.months)].filter(Boolean).join(' · ')}
                  note={roleConcern(r)}
                  evidence={r.evidence}
                  lines={lines}
                />
              ))}
            </ul>
          )}
        {read.tenure.accountedMonths !== undefined && (
          <p className="par-foot">
            Accounted tenure {monthsInWords(read.tenure.accountedMonths)} across {read.tenure.roleCount} role
            {read.tenure.roleCount === 1 ? '' : 's'}
            {read.gaps.length > 0 && ` · ${read.gaps.length} gap${read.gaps.length === 1 ? '' : 's'} in the dates`}
          </p>
        )}
      </div>

      <div role="tabpanel" id="par-panel-technologies" aria-labelledby="par-tab-technologies" hidden={tab !== 'technologies'}>
        {read.technologies.length === 0
          ? <p className="par-none">No technologies were named.</p>
          : (
            <ul className="par-list">
              {read.technologies.map((t) => (
                <Fact
                  key={t.name}
                  state={technologyState(t)}
                  title={t.name}
                  detail={monthsInWords(t.monthsUsed)}
                  note={technologyNote(t)}
                  evidence={t.evidence[0]}
                  lines={lines}
                />
              ))}
            </ul>
          )}
      </div>

      <div role="tabpanel" id="par-panel-scope" aria-labelledby="par-tab-scope" hidden={tab !== 'scope'}>
        {read.scope.length === 0
          ? <p className="par-none">The CV states no team size, budget or scale.</p>
          : (
            <ul className="par-list">
              {read.scope.map((s, i) => (
                <Fact
                  key={`${s.kind}-${i}`}
                  state="read"
                  title={s.value}
                  detail={s.kind}
                  evidence={s.evidence}
                  lines={lines}
                />
              ))}
            </ul>
          )}
      </div>

      <div role="tabpanel" id="par-panel-qualifications" aria-labelledby="par-tab-qualifications" hidden={tab !== 'qualifications'}>
        {read.qualifications.length === 0
          ? <p className="par-none">No qualifications were read.</p>
          : (
            <ul className="par-list">
              {read.qualifications.map((q, i) => (
                <Fact
                  key={`${q.level}-${i}`}
                  state="read"
                  title={`${q.level} · ${q.field}`}
                  detail={[q.displayOnly.institution, q.displayOnly.year].filter(Boolean).join(', ') || undefined}
                  note="The institution and year are shown to you and are never read by any score."
                  evidence={q.evidence}
                  lines={lines}
                />
              ))}
            </ul>
          )}
      </div>

      <div role="tabpanel" id="par-panel-not-read" aria-labelledby="par-tab-not-read" hidden={tab !== 'not-read'}>
        <p className="par-none">
          What the parser deliberately did not read, so an empty section is never mistaken for an empty CV.
        </p>
        <ul className="par-list">
          {read.redaction.linesRemoved > 0 && (
            <li className="par-fact par-read">
              <div className="par-fact-top">
                <span className="par-title">
                  {read.redaction.linesRemoved} line{read.redaction.linesRemoved === 1 ? '' : 's'} removed
                </span>
                <span className="par-detail">{redactionWords(read.redaction.kinds).join(' · ')}</span>
              </div>
              <p className="par-note">Taken out before anything read the document, and never scored.</p>
            </li>
          )}
          {read.redaction.injectionLines.length > 0 && (
            <li className="par-fact par-check">
              <div className="par-fact-top">
                <span className="par-title">
                  {read.redaction.injectionLines.length} line
                  {read.redaction.injectionLines.length === 1 ? '' : 's'} quarantined
                </span>
                <span className="par-mark">[ text aimed at a model ]</span>
              </div>
              <p className="par-note">
                Never sent to a model and never scored. Shown here because you should know it was in the document.
              </p>
            </li>
          )}
          {read.redaction.linesRemoved === 0 && read.redaction.injectionLines.length === 0 && (
            <p className="par-none">Nothing was removed from this CV.</p>
          )}
        </ul>
      </div>

      {read.modelNote && (
        <p className="par-foot">
          <Icon name="alert" size={14} /> {read.modelNote}
        </p>
      )}
    </section>
  );
}
