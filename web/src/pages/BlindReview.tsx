import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, recBadge, Banner, Stat } from '../components/ui';

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
  recommendation: string; confidence: number; evidenceCoverage: number; overallScore: number;
  summary: string; competencies: AiCompetency[];
}
interface RevealResp { id: string; result: AiResult; note: string }

type Disposition = 'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS';
const DISPOSITIONS: Disposition[] = ['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS'];

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Level picker. "Not enough evidence" is deliberately the default. */
function LevelPicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <button
        type="button"
        className={value === null ? 'btn' : 'btn ghost'}
        onClick={() => onChange(null)}
        data-testid="level-nee"
      >
        Not enough evidence
      </button>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={value === n ? 'btn' : 'btn ghost'}
          onClick={() => onChange(n)}
          data-testid={`level-${n}`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/** Side-by-side after reveal. Disagreement is the signal, so it is what stands out. */
function Comparison({ view, levels, disposition, ai }: {
  view: BlindView; levels: Record<string, number | null>; disposition: Disposition; ai: AiResult;
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
      <div className="card">
        <h3>Your call vs the AI</h3>
        <div className="row" style={{ gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
          <Stat label="You said" value={<Badge kind="blue">{disposition.replace(/_/g, ' ')}</Badge>} />
          <Stat label="AI said" value={recBadge(ai.recommendation)} />
          <Stat label="AI overall" value={`${ai.overallScore}/100`} />
          <Stat label="AI confidence" value={`${Math.round(ai.confidence * 100)}%`} />
        </div>
        {disposition !== ai.recommendation && (
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
        <h3>Competency comparison</h3>
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

      <div className="card">
        <h3>AI summary</h3>
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
  const [selfReview, setSelfReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showTranscript, setShowTranscript] = useState(true);

  useEffect(() => {
    api.get<BlindView>(`/assessments/${id}/blind`)
      .then((v) => {
        setView(v);
        setLevels(Object.fromEntries(v.competencies.map((c) => [c.id, null])));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const scoredCount = useMemo(
    () => Object.values(levels).filter((l) => l !== null).length,
    [levels],
  );

  const submit = async () => {
    if (!disposition || reason.trim().length < 3) return;
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
      // Only NOW is the AI's output fetched. Before this point it has never
      // been in the browser, so there is nothing for a curious reviewer to
      // find in devtools.
      setReveal(await api.get<RevealResp>(`/assessments/${id}/reveal`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !view) return <Banner kind="error">{error}</Banner>;
  if (!view) return <p>Loading…</p>;

  const alreadyDone = view.blindVerdictRecorded && !reveal;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2>Independent review — {view.candidate.name}</h2>
        <Link className="btn ghost" to={`/assessments/${id}`}>Full assessment</Link>
      </div>
      <p className="muted">{view.role.title}</p>

      {!reveal && (
        <Banner kind="info">
          <strong>The AI's score and recommendation are hidden until you record your own.</strong>{' '}
          {view.instructions}
        </Banner>
      )}

      {alreadyDone && (
        <Banner kind="info">
          You have already recorded a verdict for this candidate. Open the full assessment to see
          both, or continue below to review the evidence again.
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

      {reveal
        ? <Comparison view={view} levels={levels} disposition={disposition!} ai={reveal.result} />
        : (
          <>
            <div className="card">
              <h3>Score each competency from the evidence</h3>
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
                    <blockquote key={e.turnId} style={{ borderLeft: '3px solid #888', margin: '8px 0', paddingLeft: 12 }}>
                      <span style={{ opacity: 0.6, fontSize: 12 }}>{fmt(e.startMs)}</span>
                      <div>{e.quote}</div>
                    </blockquote>
                  ))}
                <LevelPicker value={levels[c.id] ?? null} onChange={(v) => setLevels((s) => ({ ...s, [c.id]: v }))} />
              </div>
            ))}

            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3>Full transcript</h3>
                <button type="button" className="btn ghost" onClick={() => setShowTranscript((s) => !s)}>
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
              <h3>Your recommendation</h3>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {DISPOSITIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={disposition === d ? 'btn' : 'btn ghost'}
                    onClick={() => setDisposition(d)}
                    data-testid={`disposition-${d}`}
                  >
                    {d.replace(/_/g, ' ')}
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
