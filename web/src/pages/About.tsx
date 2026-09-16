import { Icon, type IconName } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { WorkflowDiagram } from '../components/WorkflowDiagram';
import { SHOWCASE_FEATURES, SHOWCASE_STEPS } from '../components/landingShowcase';

/** Who each person is and what Questor actually gives them. */
const AUDIENCE: ReadonlyArray<{ key: string; icon: IconName; name: string; detail: string }> = [
  {
    key: 'recruiter',
    icon: 'candidates',
    name: 'Recruiters',
    detail: 'Turn a job description into an agreed scorecard, onboard candidates, run the first round and keep the process moving.',
  },
  {
    key: 'manager',
    icon: 'scale',
    name: 'Hiring managers',
    detail: 'Read the evidence behind a recommendation, run your own rounds, and record the decision and the reason for it.',
  },
  {
    key: 'reviewer',
    icon: 'eye',
    name: 'Reviewers',
    detail: 'Record your own verdict before Questor’s is revealed, so the assessment is a second opinion rather than a first impression.',
  },
  {
    key: 'auditor',
    icon: 'audit',
    name: 'Auditors',
    detail: 'Read what happened — consent, observation, decisions, erasures — without access to everyday candidate detail.',
  },
  {
    key: 'candidate',
    icon: 'contact',
    name: 'Candidates',
    detail: 'Told before consenting what is transcribed and kept, able to ask for a human instead, and given written feedback a person approved.',
  },
  {
    key: 'admin',
    icon: 'admin',
    name: 'Administrators',
    detail: 'Your organisation’s own sign-in link, per-person accounts, retention windows, legal holds and the connectors the deployment uses.',
  },
];

/** Said plainly, so nobody meets these as a surprise later. */
const LIMITS: readonly string[] = [
  'Questor’s scores have not been validated against human hiring judgement. Treat a score as a reason to read the evidence, not as a measurement that settles the question.',
  'No audio is kept. The voice is transcribed as it is spoken and the written transcript is what the hiring team reads.',
  'Human rounds are scheduled and recorded here, not hosted here — you hold those interviews wherever you normally do.',
  'Connector tests prove credentials work; Questor does not create Teams, Zoom or Meet meetings. The AI round runs in Questor’s own browser room.',
  'Automatic deletion at the end of a retention window only happens when the retention sweep is switched on for the deployment.',
];

export function About() {
  return (
    <div>
      <PageHeader icon="about" title="About Questor" />

      <div className="card">
        <p className="about-lede">
          Questor is one place to take a candidate from job description to decision: agree what the role
          needs, onboard the profile, run a structured first interview, schedule the human rounds around
          it, and read every rating against what the candidate actually said. A person makes the call.
        </p>

        <section className="about-section">
          <h2 className="about-heading">Why it exists</h2>
          <p>
            Most first-round screening is inconsistent by accident. Different candidates get different
            questions, notes are written from memory hours later, and the reasons behind a “no” are hard to
            reconstruct a month afterwards. That is unfair to candidates and indefensible to anyone who asks
            how a decision was reached.
          </p>
          <p>
            Questor makes the criteria explicit before anyone is measured against them, asks every candidate
            for the same evidence, and ties each rating to the moment in the transcript that supports it. Where
            the transcript does not support a competency, it says so rather than guessing.
          </p>
        </section>

        <section className="about-section">
          <h2 className="about-heading">How it works</h2>
          <WorkflowDiagram className="workflow-showcase" label="How hiring runs in Questor" steps={SHOWCASE_STEPS} />
          <p>
            Only the AI round is conducted by Schranders, our AI interviewer, in Questor’s own browser room.
            The rounds after it are yours: Questor schedules them, records who interviewed and what they
            found, and keeps it all beside the evidence from the first round.
          </p>
        </section>

        <section className="about-section">
          <h2 className="about-heading">What is in the product</h2>
          <ul className="showcase-features">
            {SHOWCASE_FEATURES.map((feature) => (
              <li key={feature.key} className="showcase-feature">
                <span className="showcase-feature-icon"><Icon name={feature.icon} size={15} /></span>
                <span className="showcase-feature-title">{feature.title}</span>
                <span className="showcase-feature-detail">{feature.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="about-section">
          <h2 className="about-heading">Who it serves</h2>
          <ul className="about-roles">
            {AUDIENCE.map((person) => (
              <li key={person.key} className="about-role">
                <span className="about-role-icon"><Icon name={person.icon} size={15} /></span>
                <span className="about-role-name">{person.name}</span>
                <span className="about-role-detail">{person.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="about-section">
          <h2 className="about-heading">What Questor does not do</h2>
          <ul className="about-limits">
            {LIMITS.map((limit) => <li key={limit}>{limit}</li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
