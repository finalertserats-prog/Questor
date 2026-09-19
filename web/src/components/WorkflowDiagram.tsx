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
  /** Called when a pointer or the keyboard reaches a step that has no link. */
  readonly onActivate?: (index: number) => void;
  /** Interaction with the sequence pauses whatever is advancing it. */
  readonly onPause?: () => void;
  readonly onResume?: () => void;
}

/**
 * The hiring workflow at a glance. Signed in, each step is a link to where it is
 * done; on the sign-in page the same sequence is shown with no destination, one
 * step highlighted at a time.
 */
export function WorkflowDiagram({
  steps = STEPS,
  label = 'Hiring workflow',
  className,
  anchor,
  activeStep,
  onActivate,
  onPause,
  onResume,
}: WorkflowDiagramProps) {
  return (
    <section
      className={className ? `workflow card ${className}` : 'workflow card'}
      aria-label={label}
      data-tour={anchor}
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
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
                // A button, not a div: pointing at or tabbing to a step selects
                // it, so the sequence is operable without a mouse.
                <button
                  type="button"
                  className={linkClass}
                  aria-current={active ? 'step' : undefined}
                  onClick={() => onActivate?.(index)}
                  onMouseEnter={() => onActivate?.(index)}
                  onFocus={() => onActivate?.(index)}
                >
                  {body}
                </button>
              )}
              {index < steps.length - 1 && <Icon name="arrow-right" size={18} className="workflow-arrow" />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
