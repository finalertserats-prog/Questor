import { Link } from 'react-router-dom';
import { Icon, type IconName } from './Icon';

interface WorkflowStep {
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
  readonly to: string;
}

// Numbered because the order is real: each step needs the one before it.
const STEPS: readonly WorkflowStep[] = [
  { icon: 'job', title: 'Create a job description', detail: 'Turn the JD into an approved scorecard.', to: '/roles/new' },
  { icon: 'onboard', title: 'Onboard a profile', detail: 'Add the candidate and parse their resume.', to: '/candidates/new' },
  { icon: 'schedule', title: 'Schedule interviews', detail: 'AI first round, then human rounds.', to: '/interviews' },
  { icon: 'evidence', title: 'Assess through evidence', detail: 'Review transcripts, then decide.', to: '/interviews' },
];

/** The hiring workflow at a glance, each step linking to where it is done. */
export function WorkflowDiagram() {
  return (
    <section className="workflow card" aria-label="Hiring workflow">
      <ol className="workflow-steps">
        {STEPS.map((step, index) => (
          <li key={step.title} className="workflow-step">
            <Link to={step.to} className="workflow-link">
              <span className="workflow-icon"><Icon name={step.icon} size={22} /></span>
              <span className="workflow-num">Step {index + 1}</span>
              <span className="workflow-title">{step.title}</span>
              <span className="workflow-detail">{step.detail}</span>
            </Link>
            {index < STEPS.length - 1 && <Icon name="arrow-right" size={18} className="workflow-arrow" />}
          </li>
        ))}
      </ol>
    </section>
  );
}
