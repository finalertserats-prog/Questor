import { Link } from 'react-router-dom';
import { Icon, type IconName } from './Icon';

export interface WorkflowStep {
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
  /** Where the step is carried out. Omitted before sign-in, where nothing is reachable yet. */
  readonly to?: string;
}

// Numbered because the order is real: each step needs the one before it.
const STEPS: readonly WorkflowStep[] = [
  { icon: 'job', title: 'Create a job description', detail: 'Turn the JD into an approved scorecard.', to: '/roles/new' },
  { icon: 'onboard', title: 'Onboard a profile', detail: 'Add the candidate and parse their resume.', to: '/candidates/new' },
  { icon: 'schedule', title: 'Schedule interviews', detail: 'AI first round, then human rounds.', to: '/interviews' },
  { icon: 'evidence', title: 'Assess through evidence', detail: 'Review transcripts, then decide.', to: '/interviews' },
];

interface WorkflowDiagramProps {
  /** Defaults to the signed-in workflow, where every step links to where it is done. */
  readonly steps?: readonly WorkflowStep[];
  readonly label?: string;
  readonly className?: string;
  /** The `data-tour` anchor the guided tour points at, on the pages it runs on. */
  readonly anchor?: string;
  /** The step drawn as current. Left undefined, no step is singled out. */
  readonly activeStep?: number;
}

/**
 * The hiring workflow at a glance. Signed in, each step is a link to where it
 * is done; where there is nowhere to go -- the public About page -- the same
 * sequence is drawn, and drawn only.
 *
 * A step with no destination used to be a <button> wired to an `onActivate`
 * prop that no caller ever passed, so the six steps on /about were focusable
 * controls that did nothing at all when clicked, hovered or tabbed to, and no
 * step was ever marked current either. Rather than invent work for them --
 * selecting a step on a page with nothing to select it for is not work -- they
 * are what they always were to read: a diagram. `activeStep` still marks one
 * as current for a caller that has a reason to.
 */
export function WorkflowDiagram({
  steps = STEPS,
  label = 'Hiring workflow',
  className,
  anchor,
  activeStep,
}: WorkflowDiagramProps) {
  return (
    <section
      className={className ? `workflow card ${className}` : 'workflow card'}
      aria-label={label}
      data-tour={anchor}
    >
      <ol className="workflow-steps">
        {steps.map((step, index) => {
          const active = index === activeStep;
          const linkClass = active ? 'workflow-link is-active' : 'workflow-link';
          const body = (
            <>
              <span className="workflow-icon"><Icon name={step.icon} size={22} /></span>
              <span className="workflow-num">Step {index + 1}</span>
              <span className="workflow-title">{step.title}</span>
              <span className="workflow-detail">{step.detail}</span>
            </>
          );
          return (
            <li key={step.title} className={active ? 'workflow-step is-active' : 'workflow-step'}>
              {step.to ? (
                <Link to={step.to} className={linkClass}>{body}</Link>
              ) : (
                <div className={linkClass} aria-current={active ? 'step' : undefined}>{body}</div>
              )}
              {index < steps.length - 1 && <Icon name="arrow-right" size={18} className="workflow-arrow" />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
