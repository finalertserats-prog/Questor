import { useState } from 'react';

// The medallion path, as HR sees it. Candidates are never shown these labels.
const STAGES: ReadonlyArray<{ key: string; label: string; detail: string }> = [
  { key: 'participation', label: 'Participation', detail: 'Profile onboarded' },
  { key: 'bronze', label: 'Bronze', detail: 'AI profile summary and job fit' },
  { key: 'silver', label: 'Silver', detail: 'AI interview with Schranders' },
  { key: 'gold', label: 'Gold', detail: 'Human interview' },
  { key: 'platinum', label: 'Platinum', detail: 'Further human round' },
  { key: 'diamond', label: 'Diamond', detail: 'Final rounds' },
];

/** Badge artwork is decorative; if an image is missing the label still reads. */
function StageBadge({ stageKey }: { stageKey: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={`stage-dot stage-dot-${stageKey}`} aria-hidden="true" />;
  return <img className="stage-badge" src={`/brand/medal-${stageKey}.png`} alt="" onError={() => setFailed(true)} />;
}

/** The left half of the login page: what Questor is, and how hiring flows through it. */
export function LandingHero() {
  const [heroFailed, setHeroFailed] = useState(false);

  return (
    <section className="landing-hero">
      {!heroFailed && <img className="landing-hero-art" src="/brand/login-hero.png" alt="" onError={() => setHeroFailed(true)} />}
      <div className="landing-hero-copy">
        <p className="landing-eyebrow">Questor</p>
        <h2 className="landing-headline">Hire through evidence, in one place.</h2>
        <p className="landing-lede">
          Create the job description, onboard the profile, run an AI first round with Schranders, schedule
          human rounds, and decide on what the evidence shows. A person makes every final call.
        </p>
        <ol className="stage-path" aria-label="Hiring stages">
          {STAGES.map((stage) => (
            <li key={stage.key} className="stage-path-item">
              <StageBadge stageKey={stage.key} />
              <span className="stage-path-label">{stage.label}</span>
              <span className="stage-path-detail">{stage.detail}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
