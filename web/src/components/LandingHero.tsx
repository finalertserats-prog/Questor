import { useEffect, useReducer, useState } from 'react';
import { Icon } from './Icon';
import { WorkflowDiagram } from './WorkflowDiagram';
import {
  SHOWCASE_FEATURES,
  SHOWCASE_STEPS,
  STEP_INTERVAL_MS,
  initialShowcaseState,
  prefersReducedMotion,
  showcaseReducer,
} from './landingShowcase';

/**
 * The showcase half of the sign-in page: what Questor does, the order it does it
 * in, and what is actually in the product. The workflow highlight advances on its
 * own and follows a pointer or the keyboard; anyone who asks for reduced motion
 * gets the same sequence held still on its first step.
 */
export function LandingHero() {
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [state, dispatch] = useReducer(showcaseReducer, reducedMotion, initialShowcaseState);

  // The preference can change while the page is open, and asking for reduced
  // motion has to stop the sequence there and then, not on the next reload.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {
      setReducedMotion(query.matches);
      dispatch({ type: query.matches ? 'pause' : 'resume' });
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (state.paused) return undefined;
    const timer = window.setInterval(() => dispatch({ type: 'tick' }), STEP_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [state.paused]);

  return (
    <section className={reducedMotion ? 'landing-hero is-still' : 'landing-hero'}>
      <div className="landing-hero-copy">
        <p className="landing-eyebrow">Questor</p>
        <h2 className="landing-headline">Hire through evidence, not impressions.</h2>
        <p className="landing-lede">
          Questor turns a job description into an agreed scorecard, runs the first interview round itself,
          schedules the human rounds around it, and ties every rating back to what the candidate actually
          said. A person still makes the decision.
        </p>

        <WorkflowDiagram
          className="workflow-showcase"
          label="How hiring runs in Questor"
          steps={SHOWCASE_STEPS}
          activeStep={state.step}
          onActivate={(step) => dispatch({ type: 'select', step })}
          onPause={() => dispatch({ type: 'pause' })}
          // Leaving the diagram must not restart a sequence that reduced motion
          // stopped: the pause is the preference, not a hover state.
          onResume={() => { if (!reducedMotion) dispatch({ type: 'resume' }); }}
        />

        <h3 className="showcase-heading">What is in the product</h3>
        <ul className="showcase-features">
          {SHOWCASE_FEATURES.map((feature) => (
            <li key={feature.key} className="showcase-feature">
              <span className="showcase-feature-icon"><Icon name={feature.icon} size={15} /></span>
              <span className="showcase-feature-title">{feature.title}</span>
              <span className="showcase-feature-detail">{feature.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
