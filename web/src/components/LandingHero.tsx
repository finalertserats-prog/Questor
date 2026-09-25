import { Icon, type IconName } from './Icon';
import { BrandLogo } from './BrandLogo';

/**
 * The welcome beside the sign-in card.
 *
 * Deliberately short. Someone arriving here is signing in, not evaluating a
 * product, and the full account — the whole workflow, everything in the product,
 * who it serves and what it will not do — lives on About, where it can be read
 * properly instead of skimmed past a form.
 */
const POINTS: ReadonlyArray<{ key: string; icon: IconName; title: string; detail: string }> = [
  {
    key: 'round',
    icon: 'interviews',
    title: 'A structured first round',
    detail: 'Run by one of our AI interviewers —the same ground with every candidate, against criteria a person approved first.',
  },
  {
    key: 'evidence',
    icon: 'evidence',
    title: 'Evidence you can read',
    detail: 'Each rating quotes the moment in the transcript behind it, and says so plainly where the transcript shows nothing.',
  },
  {
    key: 'decision',
    icon: 'scale',
    title: 'A person decides',
    detail: 'Questor gathers and recommends. Your team records the decision, and the reason stays with it.',
  },
];

export function LandingHero() {
  return (
    <section className="landing-hero">
      <div className="landing-hero-copy">
        {/* The full logo carries the product line; it is the first thing
            painted on the sign-in pages, so it alone asks to load first. */}
        <BrandLogo variant="full" size={166} priority className="landing-logo" />
        <h2 className="landing-headline">Hire through evidence, not impressions.</h2>
        <p className="landing-lede">
          A job description becomes an agreed scorecard. The first interview happens here. Every rating
          points back at what the candidate actually said.
        </p>

        <ul className="landing-points">
          {POINTS.map((point) => (
            <li key={point.key} className="landing-point">
              <span className="landing-point-icon"><Icon name={point.icon} size={15} /></span>
              <span className="landing-point-title">{point.title}</span>
              <span className="landing-point-detail">{point.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
