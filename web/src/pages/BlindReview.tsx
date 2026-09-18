import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, recBadge, Banner, Stat } from '../components/ui';
import { ValidationStatus } from './AssessmentView';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { PageSkeleton } from '../components/Skeleton';
// One list of verdicts for both review surfaces, so the pair cannot drift.
import { DISPOSITIONS, isDisposition, type Disposition } from '../components/assessmentModel';
import { formatPercent, formatScoreOutOf100 } from '../components/scoreFormat';
import { recommendationStatus } from '../components/statusModel';

// Blind-first review.
//
// The reviewer records their own judgement BEFORE seeing the AI's. That order is
// the whole point, for two reasons:
//
//  - Judgement. A reviewer who reads "PROCEED, 76/100" first anchors on it, and
//    you lose the independent read that made the second round worth running.
//  - Legal standing. Advisory-only status under GDPR Art. 22 and NYC LL144 holds
//    only while human review is genuinely independent. A reviewer who
//    rubber-stamps turns this into an automated decision in a regulator's eyes.
//
// So the AI's output is not merely hidden behind a toggle — this page never
// fetches it until a verdict exists, and the server refuses /reveal until then.

interface Evidence { turnId: string; quote: string; startMs: number; endMs: number }
interface BlindCompetency {
  id: string; name: string; definition: string; category: string;
  requiredLevel: number; indicators: string[]; evidence: Evidence[];
}
interface BlindTurn { index: number; speaker: string; text: string; competencyId: string }
interface BlindView {
  assessmentId: string; sessionId: string;
  candidate: { id: string; name: string };
  role: { id: string; title: string };
  competencies: BlindCompetency[];
  transcript: BlindTurn[];
  levelScale: Record<string, string>;
  withheld: string[];
  blindVerdictRecorded: boolean;
  instructions: string;
}

interface AiCompetency {
  id: string; name: string; level: number | null; requiredLevel: number;
  notEnoughEvidence: boolean; rationale: string;
}
interface AiResult {
  // Null when grading never produced a score (recommendation SCORING_UNAVAILABLE).
  recommendation: string; confidence: number; evidenceCoverage: number; overallScore: number | null;
  summary: string; competencies: AiCompetency[];
}
interface RevealResp { id: string; result: AiResult; note: string }


const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1,
};

/**
 * Arrow-key movement inside a group of buttons that behaves as a radio group.
 *
 * These groups look like radios and are read out as radios, so they have to
 * move like radios: a keyboard user reaching one lands on the chosen option and
 * steps through the rest with the arrows, rather than tabbing past every button
 * in the set.
 */
function moveChoice<T>(
  event: KeyboardEvent<HTMLDivElement>,
  options: readonly T[],
  value: T,
  onChange: (next: T) => void,
) {
  const step = ARROW_STEP[event.key];
  if (step === undefined) return;
  event.preventDefault();
  const at = options.indexOf(value);
  const next = at === -1 ? 0 : (at + step + options.length) % options.length;
  onChange(options[next]);
  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
}

const LEVEL_OPTIONS: readonly (number | null)[] = [null, 1, 2, 3, 4, 5];

/** Level picker. "Not enough evidence" is deliberately the default. */
function LevelPicker({ value, onChange, label }: {
  value: number | null; onChange: (v: number | null) => void; label: string;
}) {
  return (
    <div
      className="row"
      style={{ gap: 6, flexWrap: 'wrap' }}
      role="radiogroup"
      aria-label={`Level for ${label}`}
      onKeyDown={(e) => moveChoice(e, LEVEL_OPTIONS, value, onChange)}
    >
      {LEVEL_OPTIONS.map((option) => (
        <button
          key={String(option)}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          className={value === option ? 'btn' : 'btn ghost'}
          onClick={() => onChange(option)}
          data-testid={option === null ? 'level-nee' : `level-${option}`}
        >
          {option === null ? 'Not enough evidence' : option}
        </button>
      ))}
    </div>
  );
}

/** Side-by-side after reveal. Disagreement is the signal, so it is what stands out. */
function Comparison({ view, levels, disposition, ai }: {
  // Null when the verdict was recorded in an earlier visit: the server keeps
  // it, this page did not see it typed.
  view: BlindView; levels: Record<string, number | null>; disposition: Disposition | null; ai: AiResult;
}) {
  const aiById = new Map(ai.competencies.map((c) => [c.id, c]));
  const rows = view.competencies.map((c) => {
    const mine = levels[c.id] ?? null;
    const theirs = aiById.get(c.id);
    const aiLevel = theirs?.notEnoughEvidence ? null : theirs?.level ?? null;
    const bothScored = mine !== null && aiLevel !== null;
    const delta = bothScored ? mine - aiLevel : null;
    return { c, mine, aiLevel, delta, rationale: theirs?.rationale ?? '' };
  });
  const disagreements = rows.filter((r) => r.delta !== null && Math.abs(r.delta) >= 2).length;

  return (
    <>
      {/* The reveal is the exact moment the reviewer starts weighing the AI's
          number against their own, so it is the moment they need to know that
          the number has never been shown to agree with anyone. Rendered before
          the comparison card for the same reason it sits above the score on the
          full assessment: after reading it, the impression is already formed. */}
      <ValidationStatus />

      <div className="card">
        <h3 className="card-title"><Icon name="handoff" size={16} />Your call vs the AI</h3>
        <div className="row" style={{ gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
          <Stat
            label="You said"
            value={disposition
              ? <Badge kind="blue">{recommendationStatus(disposition).label}</Badge>
              : <span className="muted">Recorded earlier</span>}
          />
          <Stat label="AI said" value={recBadge(ai.recommendation)} />
          <Stat label="AI overall" value={formatScoreOutOf100(ai.overallScore)} />
          <Stat label="AI confidence" value={formatPercent(ai.confidence)} />
        </div>
        {/* An AI that produced no verdict has not disagreed with yours. */}
        {isDisposition(ai.recommendation) && disposition !== ai.recommendation && (
          <Banner kind="info">
            You and the AI reached different conclusions. Yours is the one that counts — the AI's
            output is advisory. Worth noting what it saw that you did not, or vice versa.
          </Banner>
        )}
        {disagreements > 0 && (
          <Banner kind="info">
            {disagreements} competenc{disagreements === 1 ? 'y differs' : 'ies differ'} by two levels or
            more. Those are the ones worth a second look before you finalise.
          </Banner>
        )}
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="scorecard" size={16} />Competency comparison</h3>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Competency comparison">
        <table className="table">
          <thead>
            <tr><th>Competency</th><th>You</th><th>AI</th><th>Δ</th><th>AI rationale</th></tr>
          </thead>
          <tbody>
            {rows.map(({ c, mine, aiLevel, delta, rationale }) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{mine === null ? <Badge kind="gray">NEE</Badge> : `${mine}/5`}</td>
                <td>{aiLevel === null ? <Badge kind="gray">NEE</Badge> : `${aiLevel}/5`}</td>
                <td>
                  {delta === null ? '—' : delta === 0
                    ? <Badge kind="green">match</Badge>
                    : <Badge kind={Math.abs(delta) >= 2 ? 'red' : 'amber'}>{delta > 0 ? `+${delta}` : delta}</Badge>}
                </td>
                <td style={{ fontSize: 13, opacity: 0.85 }}>{rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="insights" size={16} />AI summary</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{ai.summary}</p>
      </div>
    </>
  );
}

export default function BlindReview() {
  const { id = '' } = useParams();
  const [view, setView] = useState<BlindView | null>(null);
  const [levels, setLevels] = useState<Record<string, number | null>>({});
  const [disposition, setDisposition] = useState<Disposition | null>(null);
  const [reason, setReason] = useState('');
  const [reveal, setReveal] = useState<RevealResp | null>(null);
  // The verdict is recorded on the server even when the reveal that follows it
  // fails, and it cannot be recorded twice.
  const [verdictSaved, setVerdictSaved] = useState(false);
  const [selfReview, setSelfReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState('');
  const [showTranscript, setShowTranscript] = useState(true);

  // `cancelled` so evidence for an assessment the reviewer has already left
  // cannot appear over the one they are reading now.
  useEffect(() => {
    let cancelled = false;
    api.get<BlindView>(`/assessments/${id}/blind`)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setLevels(Object.fromEntries(v.competencies.map((c) => [c.id, null])));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the evidence.');
      });
    return () => { cancelled = true; };
  }, [id]);

  const scoredCount = useMemo(
    () => Object.values(levels).filter((l) => l !== null).length,
    [levels],
  );

  // Only ever called after a verdict is recorded. Before that point the AI's
  // output has never been in the browser, so there is nothing for a curious
  // reviewer to find in devtools.
  const loadReveal = async () => {
    setRevealing(true);
    setError('');
    try {
      setReveal(await api.get<RevealResp>(`/assessments/${id}/reveal`));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load the AI assessment.');
    } finally {
      setRevealing(false);
    }
  };

  // Two requests, two outcomes. Sharing one try meant a reveal that failed
  // rolled the screen back to an unsubmitted form over a verdict the server had
  // already accepted — and pressing save again answered 409.
  const submit = async () => {
    if (!disposition || reason.trim().length < 3 || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ selfReview: boolean }>(`/assessments/${id}/blind-verdict`, {
        disposition,
        reason: reason.trim(),
        // Only levels the reviewer actually scored. Leaving one unscored is a
        // real answer — "the transcript does not support a judgement" — and
        // must not be coerced into a number.
        competencyLevels: Object.entries(levels)
          .filter(([, l]) => l !== null)
          .map(([competencyId, l]) => ({ competencyId, level: l as number })),
      });
      setSelfReview(res.selfReview);
      setVerdictSaved(true);
      setBusy(false);
      await loadReveal();
      return;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save your verdict.');
      setBusy(false);
    }
  };

  if (error && !view) return <Banner kind="error">{error}</Banner>;
  if (!view) return <PageSkeleton label="Loading the evidence…" cards={3} />;

  // Recorded, one way or another: earlier by this reviewer, or a moment ago on
  // this screen. Either way the scoring form is no longer the thing to show —
  // pressing save again only produces a 409 from a server that is right to
  // refuse it.
  const recorded = view.blindVerdictRecorded || verdictSaved;
  const awaitingReveal = recorded && !reveal;

  return (
    <div className="stack">
      <PageHeader
        icon="eye-off"
        title={`Independent review — ${view.candidate.name}`}
        subtitle={view.role.title}
        actions={<Link className="btn ghost" to={`/assessments/${id}`}><Icon name="evidence" size={16} />Full assessment</Link>}
      />

      {!reveal && (
        <Banner kind="info">
          <strong>The AI's score and recommendation are hidden until you record your own.</strong>{' '}
          {view.instructions}
        </Banner>
      )}

      {awaitingReveal && (
        <Banner kind="info">
          Your verdict for this candidate is recorded. It cannot be edited — that is what makes it
          independent — so the only thing left here is to see what the AI made of the same evidence.
        </Banner>
      )}

      {selfReview && (
        <Banner kind="info">
          Recorded — but note you also ran this interview. Reviewing your own interview is allowed
          and has been logged; where someone else is available, an independent reviewer carries more
          weight.
        </Banner>
      )}

      {error && <Banner kind="error">{error}</Banner>}

      {reveal ? (
        <Comparison view={view} levels={levels} disposition={disposition} ai={reveal.result} />
      ) : awaitingReveal ? (
        <div className="card">
          <h3 className="card-title"><Icon name="eye" size={16} />The AI's assessment</h3>
          <p className="muted">
            Held back until a verdict was recorded. It is available now — and if this does not load,
            the full assessment page shows the same thing.
          </p>
          <button type="button" className="btn" disabled={revealing} onClick={loadReveal}>
            <Icon name={revealing ? 'hourglass' : 'eye'} size={16} />
            {revealing ? 'Loading…' : 'Show the AI assessment'}
          </button>
        </div>
      ) : (
          <>
            <div className="card">
              <h3 className="card-title"><Icon name="evidence" size={16} />Score each competency from the evidence</h3>
              <p className="muted">
                {scoredCount} of {view.competencies.length} scored. Leaving one as “not enough
                evidence” is a valid answer — judge the evidence, not how fluent the answers sounded.
              </p>
              <details style={{ marginTop: 8 }}>
                <summary>Level scale</summary>
                <ul>
                  {Object.entries(view.levelScale).map(([n, label]) => (
                    <li key={n}><strong>{n}</strong> — {label}</li>
                  ))}
                </ul>
              </details>
            </div>

            {view.competencies.map((c) => (
              <div className="card" key={c.id}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <h3>{c.name}</h3>
                  <Badge kind="gray">requires {c.requiredLevel}/5</Badge>
                </div>
                <p className="muted">{c.definition}</p>
                {c.evidence.length === 0
                  ? <Banner kind="info">No transcript evidence was captured for this competency.</Banner>
                  : c.evidence.map((e) => (
                    <blockquote key={e.turnId} className="evidence">
                      <span className="stamp">{fmt(e.startMs)}</span>
                      <div>{e.quote}</div>
                    </blockquote>
                  ))}
                <LevelPicker label={c.name} value={levels[c.id] ?? null} onChange={(v) => setLevels((s) => ({ ...s, [c.id]: v }))} />
              </div>
            ))}

            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3 className="card-title"><Icon name="captions" size={16} />Full transcript</h3>
                <button type="button" className="btn ghost" onClick={() => setShowTranscript((s) => !s)}>
                  <Icon name={showTranscript ? 'eye-off' : 'eye'} size={16} />
                  {showTranscript ? 'Hide' : 'Show'}
                </button>
              </div>
              {showTranscript && view.transcript.map((t) => (
                <p key={t.index} style={{ margin: '6px 0' }}>
                  <strong>{t.speaker === 'agent' ? 'Interviewer' : 'Candidate'}:</strong> {t.text}
                </p>
              ))}
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="decision" size={16} />Your recommendation</h3>
              <div
                className="row"
                style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}
                role="radiogroup"
                aria-label="Your recommendation"
                onKeyDown={(e) => moveChoice(e, DISPOSITIONS, disposition, (next) => setDisposition(next))}
              >
                {DISPOSITIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={disposition === d}
                    tabIndex={disposition === d || (disposition === null && d === DISPOSITIONS[0]) ? 0 : -1}
                    className={disposition === d ? 'btn' : 'btn ghost'}
                    onClick={() => setDisposition(d)}
                    data-testid={`disposition-${d}`}
                  >
                    {recommendationStatus(d).label}
                  </button>
                ))}
              </div>
              <label htmlFor="reason">Why? This is recorded against your name.</label>
              <textarea
                id="reason"
                rows={4}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What in the evidence led you here, and what would you want the next round to probe?"
              />
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                <span className="muted">
                  Once saved, your verdict cannot be edited — that is what makes it independent.
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !disposition || reason.trim().length < 3}
                  onClick={submit}
                  data-testid="submit-verdict"
                >
                  <Icon name={busy ? 'hourglass' : 'eye'} size={16} />
                  {busy ? 'Saving…' : 'Save verdict & reveal AI assessment'}
                </button>
              </div>
            </div>
          </>
        )}

      {reveal && (
        <Banner kind="info">
          {reveal.note}
        </Banner>
      )}
    </div>
  );
}
