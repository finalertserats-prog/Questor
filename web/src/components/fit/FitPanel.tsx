import { useState } from 'react';
import { Banner, Meter } from '../ui';
import { Icon } from '../Icon';
import { formatPercent, formatScoreOutOf100, roundScore } from '../scoreFormat';
import {
  EXCLUDED_SIGNALS, FIT_CAVEAT, FIT_NEEDS_A_PERSON, FIT_NEVER_SHOWN_TO_CANDIDATE,
  FIT_PROVISIONAL_LABEL, FIT_PROVISIONAL_NOTE,
} from './fitVocabulary';
import {
  bandLabel, bandMeaning, bandOf, bandTone, isDetailedFit, isProvisionalFit, strengthLabel,
  type Fit, type FitCompetencyRead, type FitEvidence, type FitTechnologyRead,
} from './fitModel';

/**
 * What the CV says about this role, and where on the CV it says it.
 *
 * Shaped around one rule: nothing here is allowed to be a number on its own.
 * Every strength carries the lines it was read from, every gap says the CV is
 * silent rather than that the candidate is short, and the panel says twice —
 * at the top and at the bottom — that this is a screening aid and not a
 * decision. The decision has its own page and its own vocabulary.
 *
 * Drawn the way the rest of the product draws state: a rule down the left edge
 * in the colour of the reading, and the reading itself said in words. No
 * tinted fills, so the panel still reads correctly to someone who cannot tell
 * the colours apart.
 */

export function FitPanel({ fit, rescoredNote }: { fit: Fit | null; rescoredNote?: string | null }) {
  if (!fit) {
    return <p className="muted">No resume fit is available until a resume has been parsed against an approved scorecard.</p>;
  }
  if (!isDetailedFit(fit)) return <LegacyFit fit={fit} />;

  const competencies = fit.competencies ?? [];
  const strengths = competencies.filter((c) => c.strength === 'evidenced');
  const thin = competencies.filter((c) => c.strength === 'partial');
  const silent = competencies.filter((c) => c.strength === 'not_evidenced');
  const tone = bandTone(fit);
  // The endpoint does not echo this list back beside a named candidate, so the
  // panel reads the copy a server test keeps identical to the engine's own.
  const excluded = fit.excludedSignals ?? EXCLUDED_SIGNALS;

  const provisional = isProvisionalFit(fit);

  return (
    <div className="fit" data-testid="fit-panel">
      <div className={`fit-head is-${tone}`}>
        <div className="fit-read">
          <div className="fit-word" data-testid="fit-band">
            {bandLabel(fit)}
            {provisional && <span className="fit-tag" data-testid="fit-provisional-tag">{FIT_PROVISIONAL_LABEL}</span>}
          </div>
          <p className="fit-meaning" data-testid="fit-meaning">{bandMeaning(fit)}</p>
          {bandOf(fit) === 'not_enough_evidence' && (
            <p className="fit-note" data-testid="fit-needs-a-person">{FIT_NEEDS_A_PERSON}</p>
          )}
        </div>
        <dl className="fit-figures">
          <Figure label="Overall" value={formatScoreOutOf100(fit.overall)} testId="fit-overall">
            <Meter value={roundScore(fit.overall) ?? 0} />
          </Figure>
          <Figure label="Of the scorecard the CV speaks to" value={fit.coverage === undefined ? '—' : formatPercent(fit.coverage)} testId="fit-coverage" />
          <Figure label="Confidence in this reading" value={formatPercent(fit.confidence)} testId="fit-confidence" />
        </dl>
      </div>

      {provisional && (
        <Banner kind="error"><span data-testid="fit-provisional">{FIT_PROVISIONAL_NOTE}</span></Banner>
      )}
      <Banner kind="info">{FIT_CAVEAT}</Banner>
      <p className="fit-internal"><Icon name="lock" size={14} />{FIT_NEVER_SHOWN_TO_CANDIDATE}</p>
      {rescoredNote && <Banner kind="info">{rescoredNote}</Banner>}
      {fit.redaction && <RedactionNote redaction={fit.redaction} />}

      {(fit.mustHaveGaps ?? []).length > 0 && (
        <section className="fit-block is-stop" data-testid="fit-must-haves">
          <h3 className="fit-h">Must-haves this CV does not evidence</h3>
          <ul className="fit-list">
            {fit.mustHaveGaps!.map((m) => <li key={m}>{m}</li>)}
          </ul>
          <p className="fit-note">The CV being silent is not the same as the candidate being unable. These are the first things the interview asks about.</p>
        </section>
      )}

      <section className="fit-block is-pass" data-testid="fit-strengths">
        <h3 className="fit-h">Strengths, with the lines they were read from</h3>
        {strengths.length === 0
          ? <p className="fit-note">Nothing on this CV reaches the bar for evidenced against this role's competencies.</p>
          : <CompetencyList reads={strengths} />}
        {thin.length > 0 && (
          <>
            <h4 className="fit-h4">Claimed, but only once</h4>
            <CompetencyList reads={thin} />
          </>
        )}
      </section>

      {silent.length > 0 && (
        <section className="fit-block" data-testid="fit-silent">
          <h3 className="fit-h">What the CV does not mention</h3>
          <ul className="fit-list">
            {silent.map((c) => <li key={c.competencyId}>{c.name}</li>)}
          </ul>
          <p className="fit-note">These are carried as unknown, not as zero. A CV that does not mention something is not evidence that it is absent.</p>
        </section>
      )}

      {(fit.technologies ?? []).length > 0 && <Technologies technologies={fit.technologies!} />}

      <section className="fit-block is-hold" data-testid="fit-probes">
        <h3 className="fit-h">What the interview will probe</h3>
        {(fit.probeDetail ?? []).length === 0 && fit.probes.length === 0
          ? <p className="fit-note">Nothing stands out as needing a specific check.</p>
          : (
            <ol className="fit-probes">
              {(fit.probeDetail ?? fit.probes.map((text) => ({ text, reason: '' }))).map((p, i) => (
                <li key={i}>
                  <span className="fit-probe-text">{p.text}</span>
                  {p.reason && <span className="fit-probe-why">{p.reason}</span>}
                </li>
              ))}
            </ol>
          )}
        <p className="fit-note">These reach the interview plan, so the conversation checks what the CV left open.</p>
      </section>

      {fit.tenureNote && (
        <section className="fit-block" data-testid="fit-tenure">
          <h3 className="fit-h">About the shape of this career</h3>
          <p className="fit-note">{fit.tenureNote}</p>
          <p className="fit-note">Neither gaps nor short tenures move the score. They are here because a person reading a CV should see them and decide for themselves whether to ask.</p>
        </section>
      )}

      {(fit.niceToHavesPresent ?? []).length > 0 && (
        <section className="fit-block" data-testid="fit-nice-to-have">
          <h3 className="fit-h">Nice-to-haves this CV does have</h3>
          <div className="fit-chips">{fit.niceToHavesPresent!.map((n) => <span key={n} className="fit-chip">{n}</span>)}</div>
        </section>
      )}

      <Components fit={fit} />

      {excluded.length > 0 && (
        <section className="fit-block" data-testid="fit-excluded">
          <h3 className="fit-h">Deliberately not read</h3>
          <div className="fit-chips">{excluded.map((s) => <span key={s} className="fit-chip is-muted">{s}</span>)}</div>
          <p className="fit-note">None of these reached the score. Each is either a protected characteristic or a reliable stand-in for one.</p>
        </section>
      )}
    </div>
  );
}

function Figure({ label, value, testId, children }: { label: string; value: string; testId: string; children?: React.ReactNode }) {
  return (
    <div className="fit-figure">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
      {children}
    </div>
  );
}

function CompetencyList({ reads }: { reads: readonly FitCompetencyRead[] }) {
  return (
    <ul className="fit-reads">
      {reads.map((c) => (
        <li key={c.competencyId} className="fit-read-row" data-testid={`fit-competency-${c.competencyId}`}>
          <div className="fit-read-head">
            <b>{c.name}</b>
            {c.mustHave && <span className="fit-tag">must-have</span>}
            <span className="fit-strength">{strengthLabel(c.strength)}</span>
          </div>
          <p className="fit-note">{c.explanation}</p>
          <Quotes evidence={c.evidence} />
        </li>
      ))}
    </ul>
  );
}

function Quotes({ evidence }: { evidence: readonly FitEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="fit-quotes">
      {evidence.map((e) => (
        <li key={`${e.line}-${e.quote.slice(0, 12)}`}>
          <q>{e.quote}</q>
          <span className="fit-where">CV line {e.line + 1}, {e.section}</span>
        </li>
      ))}
    </ul>
  );
}

function Technologies({ technologies }: { technologies: readonly FitTechnologyRead[] }) {
  return (
    <section className="fit-block" data-testid="fit-technologies">
      <h3 className="fit-h">This role's technologies on this CV</h3>
      <ul className="fit-reads">
        {technologies.map((t) => (
          <li key={t.name} className="fit-read-row" data-testid={`fit-technology-${t.name}`}>
            <div className="fit-read-head">
              <b>{t.name}</b>
              <span className="fit-tag">{t.required ? 'required' : 'nice to have'}</span>
              <span className="fit-strength">{strengthLabel(t.strength)}</span>
            </div>
            <p className="fit-note">{t.explanation}</p>
            <Quotes evidence={t.evidence.slice(0, 2)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Components({ fit }: { fit: Fit }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="fit-block" data-testid="fit-components">
      <button type="button" className="fit-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'eye-off' : 'eye'} size={14} />
        How the overall number was reached
      </button>
      {open && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="How the fit number was reached">
          <table>
            <thead><tr><th>Part</th><th>Weight</th><th>Score</th><th>What it says</th></tr></thead>
            <tbody>
              {fit.components.map((c) => (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td className="fit-num">{Math.round(c.weight * 100)}%</td>
                  <td className="fit-num">{Math.round(c.score)}</td>
                  <td className="muted small">
                    <div>{c.explanation ?? c.rule}</div>
                    {c.explanation && <div className="fit-rule">{c.rule}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RedactionNote({ redaction }: { redaction: NonNullable<Fit['redaction']> }) {
  const parts: string[] = [];
  if (redaction.linesRemoved > 0) {
    parts.push(`${redaction.linesRemoved} line${redaction.linesRemoved === 1 ? '' : 's'} of personal detail were removed before scoring and were never read.`);
  }
  if (redaction.injectionLines.length > 0) {
    parts.push(`${redaction.injectionLines.length} line${redaction.injectionLines.length === 1 ? '' : 's'} in this CV tried to give instructions to the system. They were ignored and not scored, and a person should look at this CV.`);
  }
  if (parts.length === 0) return null;
  return (
    <Banner kind={redaction.injectionLines.length > 0 ? 'error' : 'info'}>
      <span data-testid="fit-redaction">{parts.join(' ')}</span>
    </Banner>
  );
}

/** A fit stored before the evidence-backed engine: shown as it was, and said to be old. */
function LegacyFit({ fit }: { fit: Fit }) {
  return (
    <div className="fit" data-testid="fit-panel-legacy">
      <dl className="fit-figures">
        <Figure label="Overall" value={formatScoreOutOf100(fit.overall)} testId="fit-overall">
          <Meter value={roundScore(fit.overall) ?? 0} />
        </Figure>
        <Figure label="Confidence" value={formatPercent(fit.confidence)} testId="fit-confidence" />
      </dl>
      <Banner kind="info">
        This reading was made by an earlier version of the fit engine and has no evidence behind it. Re-upload the resume to have it read line by line.
      </Banner>
      {fit.missing.length > 0 && (
        <section className="fit-block">
          <h3 className="fit-h">Missing signals</h3>
          <ul className="fit-list">{fit.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
