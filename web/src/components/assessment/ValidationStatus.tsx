import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Banner } from '../ui';

// ---------------------------------------------------------------------------
// Scoring-validity status
// ---------------------------------------------------------------------------

/** The fields of GET /api/assessments/shadow-metrics this UI reads. */
interface ShadowMetrics {
  sampleSize: { blindVerdicts: number; assessmentsTotal: number; coverage: number };
  sufficiency: { sufficient: boolean; minimumN: number; statement: string };
  gate: { source: string; threshold: number; statistic: string; met: boolean | null; statement: string };
}

/**
 * States, wherever an AI recommendation or score is on screen, that the scoring
 * has never been checked against human judgement.
 *
 * WHY: "advisory" on its own does not carry this. A reviewer reads it as a
 * liability disclaimer on a number that was nonetheless measured — and then
 * weighs the number accordingly. The thing they actually need to know is that
 * no agreement study has ever been run, which is a fact about the data, not a
 * caveat about liability.
 *
 * Every sentence of substance below is the SERVER'S wording, from
 * services/shadowMode.ts. That is deliberate: this component must not be able
 * to describe a state the harness would describe differently, and it must not
 * do its own arithmetic on the sample — a number computed here could flatter
 * the system without anyone noticing the divergence.
 *
 * It is not collapsible and has no dismiss control. The failure being designed
 * against is a caveat the reviewer learns to close.
 */
export function ValidationStatus() {
  const [metrics, setMetrics] = useState<ShadowMetrics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.get<ShadowMetrics>('/assessments/shadow-metrics')
      .then(setMetrics)
      .catch(() => setFailed(true));
  }, []);

  // Never render nothing. An absent notice reads as "no caveat applies", which
  // is the single message this component exists to prevent — so the unvalidated
  // headline is shown while loading and stays shown if the fetch fails.
  if (!metrics) {
    return (
      <Banner kind="error">
        <strong>This score has not been validated against human judgement.</strong>{' '}
        {failed
          ? 'The live agreement statistics could not be loaded, so nothing here has been confirmed either way.'
          : 'Loading the current agreement statistics…'}
      </Banner>
    );
  }

  const { sufficiency, gate } = metrics;
  // A met gate is still not validation: it is one measurement, against one
  // conservative reading of a launch gate, on a sample that may not be
  // representative. Only the headline softens — nothing else changes.
  const validated = gate.met === true;

  return (
    <Banner kind={validated ? 'info' : 'error'}>
      <strong>
        {validated
          ? 'The agreement gate condition is currently met — but this score is still not a validated measure.'
          : 'This score has not been validated against human judgement.'}
      </strong>
      <div style={{ marginTop: 6 }}>{sufficiency.statement}</div>
      <div style={{ marginTop: 6 }}>{gate.statement}</div>
      <div className="small" style={{ marginTop: 8, opacity: 0.9 }}>
        Nothing here becomes validated by accumulating verdicts. {sufficiency.minimumN} paired blind
        verdicts is only the point at which the confidence interval starts to mean anything — a floor for
        reading the statistic, not a pass mark. Clearing the gate additionally requires the LOWER bound of
        {/* Named, because every other number on this page is out of 100 or a
            percentage, and a bare "0.75" beside them reads as one of those. */}
        that interval to reach a kappa of {gate.threshold}, which a larger sample does not bring about on its own.
        Treat the recommendation and score as one opinion to argue with, not as a measurement.
      </div>
      <details style={{ marginTop: 8 }}>
        <summary className="small">How this is measured</summary>
        <p className="small" style={{ marginBottom: 4 }}>{gate.statistic}</p>
        <p className="small muted" style={{ margin: 0 }}>{gate.source}</p>
      </details>
    </Banner>
  );
}
