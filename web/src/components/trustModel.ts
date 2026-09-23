/**
 * What Questor says about the laws it is built for and the security it runs
 * with — the About page's trust section and the sign-in footer both read this.
 *
 * Every entry is grounded in docs/compliance/REGULATORY_ANALYSIS.md and checked
 * against the code before it says "In place". The rule is the owner's: show the
 * research, never claim what is not built. Anything still a stub or still a
 * programme rather than code says so. Kept free of React so a test can hold the
 * two surfaces to the same list (web/tests/trustCompliance.test.ts).
 */

export type TrustStatus = 'in-place' | 'in-progress' | 'planned';

export const TRUST_STATUSES: readonly TrustStatus[] = ['in-place', 'in-progress', 'planned'];

const STATUS_LABELS: Readonly<Record<TrustStatus, string>> = {
  'in-place': 'In place',
  'in-progress': 'In progress',
  planned: 'Planned',
};

export function trustStatusLabel(status: TrustStatus): string {
  return STATUS_LABELS[status];
}

/** The About page anchor the sign-in footer links to. */
export const TRUST_SECTION_ID = 'trust';

export interface TrustItem {
  readonly key: string;
  readonly topic: string;
  /** What the law asks, in one sentence. */
  readonly asks: string;
  /** What Questor does about it, in plain words. */
  readonly questor: string;
  readonly status: TrustStatus;
}

export interface TrustFramework {
  readonly key: string;
  readonly name: string;
  readonly scope: string;
  /** Set only for frameworks named in the sign-in footer. */
  readonly footerLabel?: string;
  readonly items: readonly TrustItem[];
}

export const TRUST_FRAMEWORKS: readonly TrustFramework[] = [
  {
    key: 'eu-ai-act',
    name: 'EU AI Act',
    scope: 'High-risk: AI used to evaluate candidates for employment (Annex III, point 4(a)). Advisory scoring does not change that.',
    footerLabel: 'EU AI Act',
    items: [
      {
        key: 'ai-act-oversight',
        topic: 'Human oversight (Art. 14)',
        asks: 'People must be able to understand, question and override the system, and guard against trusting it blindly.',
        questor: 'A person makes every decision. Reviewers can record their own verdict before Questor’s is revealed, every rating points to the transcript that supports it, and a review records its reason and any rating it changed.',
        status: 'in-place',
      },
      {
        key: 'ai-act-transparency',
        topic: 'Transparency (Art. 13, 50, 86)',
        asks: 'Candidates must know they are dealing with an AI and can ask how it affected their assessment.',
        questor: 'Before consenting, candidates are told the first round is run by an AI interviewer and what is transcribed. Their feedback email carries a link to ask to speak to a person.',
        status: 'in-place',
      },
      {
        key: 'ai-act-logging',
        topic: 'Record-keeping (Art. 12, 26(5))',
        asks: 'The system must keep automatic logs long enough to audit how it was used.',
        questor: 'An audit log records consent, observation, decisions, overrides and erasures. It holds no transcript text, and erasing a candidate does not erase the record that it happened.',
        status: 'in-place',
      },
      {
        key: 'ai-act-fairness',
        topic: 'Bias and data quality (Art. 10)',
        asks: 'The data behind the system must be relevant and checked for discriminatory bias.',
        questor: 'The Reports page measures outcomes: the funnel from invitation to decision, score and competency distributions, and how those differ by AI interviewer, scorecard version, experience band, region and month — every rate with the sample it was computed from, and marked unreadable below 20. Group-level adverse impact is still not computed and cannot be: it needs demographic attributes we do not collect. The page says so on itself rather than letting outcome rates be mistaken for a bias audit.',
        status: 'in-progress',
      },
      {
        key: 'ai-act-fria',
        topic: 'Impact assessment (Art. 27)',
        asks: 'Deployers must assess the effect on candidates’ fundamental rights before use.',
        questor: 'Our regulatory analysis is written; a formal fundamental-rights impact assessment and a conformity assessment have not been done yet.',
        status: 'planned',
      },
    ],
  },
  {
    key: 'gdpr',
    name: 'GDPR',
    scope: 'Candidates in the EU and EEA. The hiring organisation is the controller; Questor processes on its behalf.',
    footerLabel: 'GDPR',
    items: [
      {
        key: 'gdpr-art22',
        topic: 'Automated decisions (Art. 22)',
        asks: 'No one may be subject to a decision made solely by automated means, and human review must be meaningful, not a rubber stamp.',
        questor: 'The score is advisory. The review page puts the transcript first, reviewers can judge before seeing Questor’s view, and a person records the decision and why.',
        status: 'in-place',
      },
      {
        key: 'gdpr-erasure',
        topic: 'Erasure and storage limitation (Art. 17, 5(1)(e))',
        asks: 'Personal data must be deleted on request and not kept longer than its purpose needs.',
        questor: 'An administrator can erase a candidate on request. Interviews carry a retention window (180 days unless the deployment sets another) with legal holds, and the deployment switches on the sweep that deletes on schedule.',
        status: 'in-place',
      },
      {
        key: 'gdpr-dpia',
        topic: 'Data protection impact assessment (Art. 35)',
        asks: 'High-risk processing needs a documented assessment of risks and the measures against them.',
        questor: 'A summary is below. It is drawn from our own analysis, which has not yet been reviewed by a lawyer.',
        status: 'in-progress',
      },
      {
        key: 'gdpr-processors',
        topic: 'Processors and transfers (Art. 28, Chapter V)',
        asks: 'Anyone processing candidate data for the employer needs a written agreement, and transfers abroad need a lawful basis.',
        questor: 'Transcripts go only to the AI model provider the deployment configures, for scoring. A standard processing agreement for customers is not published yet.',
        status: 'planned',
      },
    ],
  },
  {
    key: 'dpdp',
    name: 'India DPDP Act, 2023',
    scope: 'Candidates in India. The hiring organisation is the data fiduciary.',
    footerLabel: 'DPDP',
    items: [
      {
        key: 'dpdp-consent',
        topic: 'Notice and consent (s. 5, 6)',
        asks: 'Say what data is collected and why before collecting it, and get consent that can be withdrawn.',
        questor: 'Candidates read what is transcribed and kept before they consent, can ask for an accommodation or a human instead, and can withdraw.',
        status: 'in-place',
      },
      {
        key: 'dpdp-retention',
        topic: 'Deletion once the purpose is served (s. 8)',
        asks: 'Delete candidate data when the recruitment it was collected for is over.',
        questor: 'The same retention windows, legal holds and erasure as above.',
        status: 'in-place',
      },
      {
        key: 'dpdp-grievance',
        topic: 'Grievance contact (s. 5)',
        asks: 'The notice must say who to contact about the data and how to complain.',
        questor: 'A place for each organisation to name its data-protection contact in the candidate notice is still to be built.',
        status: 'planned',
      },
    ],
  },
  {
    key: 'illinois-aivia',
    name: 'Illinois Artificial Intelligence Video Interview Act',
    scope: 'Employers who use AI to analyse applicants’ video interviews.',
    footerLabel: 'Illinois AIVI Act',
    items: [
      {
        key: 'aivia-video',
        topic: 'Notice, consent and deletion',
        asks: 'Before AI analyses a video interview, explain how it works, get consent, and delete the recording within 30 days of a request.',
        questor: 'Questor records no video and uses no camera: the AI round is voice or text, and no audio is kept. Notice, consent and erasure on request apply all the same.',
        status: 'in-place',
      },
    ],
  },
  {
    key: 'nyc-ll144',
    name: 'NYC Local Law 144',
    scope: 'Automated employment decision tools used for roles in New York City.',
    items: [
      {
        key: 'll144-advisory',
        topic: 'Advisory, not deciding',
        asks: 'The law applies when a tool’s output substantially assists or replaces the hiring decision.',
        questor: 'The AI round is one input among the human rounds, notes and decision a person records; Questor never rejects anyone on its own.',
        status: 'in-place',
      },
      {
        key: 'll144-audit',
        topic: 'Independent bias audit',
        asks: 'If the tool does carry that weight, it needs a yearly independent bias audit with a published summary.',
        questor: 'No bias audit has been done. It depends on the fairness monitoring above.',
        status: 'planned',
      },
    ],
  },
  {
    key: 'other-states',
    name: 'Maryland and Colorado',
    scope: 'Maryland’s limit on facial recognition in interviews; Colorado’s AI Act duty of care for high-risk AI in hiring.',
    items: [
      {
        key: 'maryland-face',
        topic: 'Facial recognition (Md. Lab. & Empl. § 3-717)',
        asks: 'No facial recognition in a job interview without the applicant’s written consent.',
        questor: 'Questor uses no facial recognition.',
        status: 'in-place',
      },
      {
        key: 'colorado-risk',
        topic: 'Risk management (Colorado AI Act)',
        asks: 'Deployers of high-risk AI must review risk yearly, assess impact and tell candidates about the tool.',
        questor: 'Candidates are told; the yearly risk review waits on the impact assessment and fairness monitoring above.',
        status: 'in-progress',
      },
    ],
  },
  {
    key: 'accessibility',
    name: 'Accessibility',
    scope: 'Candidates and staff using assistive technology. We work to WCAG 2.2 AA.',
    items: [
      {
        key: 'a11y-product',
        topic: 'Usable by everyone',
        asks: 'People with disabilities must be able to take part, with reasonable adjustments where needed.',
        questor: 'Form labels are bound to their controls, text and field edges are set for AA contrast, and candidates can type instead of speak or ask for an accommodation on the consent screen. No independent accessibility audit has been done yet.',
        status: 'in-progress',
      },
    ],
  },
];

/** Security measures, each checked in the server code before it is listed. */
export const TRUST_SECURITY: readonly TrustItem[] = [
  {
    key: 'sec-tenancy',
    topic: 'Tenant isolation and role-based access',
    asks: 'One organisation must never see another’s candidates, and people see only what their role needs.',
    questor: 'Data is scoped to the signed-in person’s organisation by design, and actions check the role’s permission and access to the record. Independent testing of this is still planned (see below).',
    status: 'in-place',
  },
  {
    key: 'sec-sessions',
    topic: 'Sign-in and sessions',
    asks: 'Credentials and sessions must resist theft and forged requests.',
    questor: 'Passwords are stored as bcrypt hashes; the session lives in an httpOnly, same-site cookie; every state-changing request is checked against forgery; standard security headers are set.',
    status: 'in-place',
  },
  {
    key: 'sec-rate-limits',
    topic: 'Rate limits',
    asks: 'Sign-in and costly endpoints must not be open to guessing or abuse.',
    questor: 'Sign-in, candidate interview endpoints, uploads and invitations are rate limited, and sign-in refuses rather than waves through when its limiter cannot be checked.',
    status: 'in-place',
  },
  {
    key: 'sec-sealed',
    topic: 'Sealed secrets',
    asks: 'Stored credentials must not be readable from a database copy.',
    questor: 'Candidate invitation links and connector credentials are encrypted with AES-256-GCM under a key only the running application holds.',
    status: 'in-place',
  },
  {
    key: 'sec-audit',
    topic: 'Audit log and legal holds',
    asks: 'What happened to candidate data must be provable later.',
    questor: 'Consent, decisions, overrides, erasures and retention runs are logged; a legal hold stops deletion of the interviews it covers.',
    status: 'in-place',
  },
  {
    key: 'sec-at-rest',
    topic: 'Encryption of stored candidate data',
    asks: 'Personal data at rest should be protected if the host is compromised.',
    questor: 'Candidate records rely on the host’s own protection today; encryption at rest for them is planned.',
    status: 'planned',
  },
  {
    key: 'sec-pentest',
    topic: 'Independent security testing',
    asks: 'Security claims should be checked by someone outside the team.',
    questor: 'No penetration test or security certification has been done yet.',
    status: 'planned',
  },
];

/** The element id a URL hash points at; a malformed hash (`#%`) is ignored rather than thrown on. */
export function sectionIdFromHash(hash: string): string | null {
  if (hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

export interface DpiaPart {
  readonly heading: string;
  readonly points: readonly string[];
}

/** The short DPIA summary, drawn from the regulatory analysis. */
export const DPIA_SUMMARY: readonly DpiaPart[] = [
  {
    heading: 'What is processed',
    points: [
      'Candidate name, contact details and CV.',
      'The interview transcript — voice is transcribed as it is spoken and no audio is kept.',
      'Competency ratings, the AI recommendation, reviewers’ notes and the decision.',
      'Consent and accommodation requests.',
    ],
  },
  {
    heading: 'Why',
    points: [
      'To run a structured first-round interview for the role the candidate applied for, and to give the hiring team evidence to decide on.',
    ],
  },
  {
    heading: 'Main risks',
    points: [
      'Reviewers trusting the score instead of reading the evidence.',
      'Unfair outcomes for some groups of candidates.',
      'Data kept longer than the recruitment needs, or seen by the wrong people.',
      'Transcripts leaving the candidate’s country for scoring.',
    ],
  },
  {
    heading: 'How they are reduced',
    points: [
      'A person decides; blind review and evidence-linked ratings work against rubber-stamping.',
      'Fairness monitoring is in progress, and a bias audit is planned.',
      'Retention windows, legal holds, erasure on request, tenant isolation and role-based access.',
      'Transcripts go only to the configured AI model provider, for scoring.',
    ],
  },
];

/** The frameworks named in the sign-in footer: only ones the About page covers. */
export const FOOTER_FRAMEWORKS: readonly string[] = ['gdpr', 'dpdp', 'eu-ai-act', 'illinois-aivia']
  .map((key) => TRUST_FRAMEWORKS.find((f) => f.key === key)?.footerLabel)
  .filter((label): label is string => Boolean(label));
