import { describe, it, expect } from 'vitest';
import {
  MIN_CONTRIBUTING_WEIGHT, contributingLines, isContributing, sectionWeight, segmentJd,
} from '../src/engines/jdSections.js';
import { excludedBy } from '../src/engines/jdExclusions.js';
import { eligibilityRequirements, readEligibility } from '../src/engines/eligibility.js';
import { proposeFromJd } from '../src/engines/jdCompetencies.js';
import { extractCvFacts } from '../src/engines/cvFacts.js';
import { scoreFit } from '../src/engines/fitScoring.js';
import type { RoleSuccessProfile } from '../src/domain/types.js';

/**
 * An advert can ask for two different things and the extractor used to hear
 * only one of them.
 *
 * "Deep SQL" is a capability: it is graded, interviewed and scored. "An active
 * NMC registration" is not — a person either holds it or does not, no
 * conversation will change the answer, and getting it wrong is a legal
 * problem rather than a hiring one. Both used to land in the same bin, and the
 * second was then silently dropped.
 *
 * These tests pin the two halves apart: an eligibility line may never become a
 * competency and may never move a score, and a line of genuine boilerplate may
 * never be put in front of HR as something to check against a person.
 *
 * The adverts below are deliberately NOT drawn from bench/jd. That corpus was
 * written by the same hand that wrote the extractor, so passing on it says
 * nothing about wording nobody anticipated.
 */

const NURSING_JD = `Clinical Nurse Specialist — Respiratory
Location: Dundee | Employment type: Full-time

About the role
We run a nurse-led respiratory service across two community sites.

What you'll do
- Run a nurse-led clinic two days a week and review inhaler technique with every patient.
- Escalate a deteriorating patient the same day, and write up why.

Requirements
- Current NMC registration with an active licence to practise is required.
- A degree in nursing, or an equivalent pre-registration award.
- Applicants must have the right to work in the United Kingdom.

Benefits
- A professional development allowance of £1,200 a year.

Tayside Respiratory is an equal opportunities employer. All offers are subject to a
background check and a satisfactory reference.`;

/**
 * Legal-sounding from top to bottom, and asks for no credential at all.
 *
 * This is the advert that decides whether the patterns are conservative. Every
 * sentence below is the kind of thing a nervous employment lawyer adds to a
 * job advert, and not one of them is a requirement a person could be measured
 * against. If any of it reaches HR as something to check, the feature is
 * costing attention rather than saving it.
 */
const LEGAL_SOUNDING_JD = `Compliance Analyst

About the role
You will keep our financial promotions within the rules and say so in writing.

Requirements
- Experience with FCA-regulated financial promotions in a retail bank.
- Comfortable with a high degree of ambiguity, and willing to say when something is wrong.
- Strong written English; you must be able to defend a judgement in a paragraph.

Other information
- This is an at-will employment relationship and either party may end it.
- Employment is conditional on a satisfactory background check and references.
- Please read our privacy notice before applying. Terms and conditions apply.
- All offers are subject to a right to work check.
- We are unable to offer visa sponsorship for this position.`;

const CLEARED_JD = `Systems Engineer — Ground Segment

What you'll do
- Own the ground segment build and its integration with the spacecraft simulator.

Requirements
- Active SC security clearance is mandatory before your first day on site.
- Chartered Engineer status, or a clear route to it within two years.
- Experience with model-based systems engineering.`;

function sectionOfLineContaining(jd: string, needle: string): string {
  for (const section of segmentJd(jd)) {
    for (const line of section.lines) {
      if (line.text.includes(needle)) return section.kind;
    }
  }
  throw new Error(`no line contains ${needle}`);
}

describe('the eligibility section', () => {
  it('contributes nothing, so an eligibility line can never become a competency', () => {
    expect(sectionWeight('eligibility')).toBeLessThan(MIN_CONTRIBUTING_WEIGHT);
    expect(isContributing('eligibility')).toBe(false);
  });

  it('is never offered to the extractor', () => {
    const texts = contributingLines(NURSING_JD).map((l) => l.text).join('\n');
    expect(texts).not.toContain('NMC registration');
    expect(texts).not.toContain('right to work');
    expect(texts).toContain('Run a nurse-led clinic');
  });

  it('proposes no competency from a licence requirement', () => {
    const jd = `Locum Pharmacist\n\nRequirements\n- A current GPhC licence to practise is required.\n- Applicants must have the right to work in the UK.\n`;
    expect(proposeFromJd(jd, { title: 'Locum Pharmacist' }).filter((c) => c.origin === 'jd')).toEqual([]);
  });
});

describe('telling an eligibility requirement from boilerplate', () => {
  const cases: Array<{ line: string; section: string; why: string }> = [
    { line: 'Applicants must have the right to work in the United Kingdom.', section: 'eligibility', why: 'a requirement of the person' },
    { line: 'An active RN licence is required.', section: 'eligibility', why: 'a credential, stated as required' },
    { line: 'Full UK driving licence.', section: 'eligibility', why: 'a credential, stated as current' },
    { line: 'Active SC security clearance is mandatory before your first day on site.', section: 'eligibility', why: 'a clearance the person holds' },
    { line: 'Registration with the NMC is essential.', section: 'eligibility', why: 'registration with a professional body' },

    { line: 'This is an at-will employment relationship and either party may end it.', section: 'boilerplate', why: 'nobody checks it against a candidate' },
    { line: 'Please read our privacy notice before applying.', section: 'boilerplate', why: 'a notice, not a requirement' },
    { line: 'Terms and conditions apply.', section: 'boilerplate', why: 'a notice, not a requirement' },
    { line: 'All offers are subject to a background check and a satisfactory reference.', section: 'boilerplate', why: 'a condition of the offer, not a credential the candidate holds' },
    { line: 'Employment is conditional on a satisfactory background check and references.', section: 'boilerplate', why: 'a condition of the offer' },
    { line: 'All offers are subject to a right to work check.', section: 'boilerplate', why: 'the employer\'s own process, not something to read a CV for' },
  ];

  for (const { line, section, why } of cases) {
    it(`files "${line.slice(0, 44)}…" under ${section} — ${why}`, () => {
      expect(excludedBy(line)?.section).toBe(section);
    });
  }

  it('reads a negated credential as the denial it is, not as a requirement', () => {
    expect(excludedBy("You don't need a computer science degree.")?.id).toBe('negated_requirement');
    expect(excludedBy('You do not need a driving licence for this role.')?.id).toBe('negated_requirement');
  });

  it('leaves a capability that merely names a certification alone', () => {
    // The advert is asking for the work of running a certification, which is
    // graded and interviewed. It is not asking whether the person holds one.
    expect(excludedBy('Maintain our ISO 27001 certification and lead the annual surveillance audit.')).toBeNull();
    expect(excludedBy('Experience with certification workflows in a regulated environment.')).toBeNull();
  });

  it('does not mistake a degree of ambiguity for a degree', () => {
    expect(excludedBy('Comfortable with a high degree of ambiguity, and willing to say when something is wrong.')).toBeNull();
  });
});

describe('eligibilityRequirements', () => {
  const found = eligibilityRequirements(NURSING_JD);

  it('finds the credential-shaped requirements and nothing else', () => {
    expect(found.map((r) => r.kind).sort()).toEqual(['education', 'registration', 'right_to_work']);
  });

  it('quotes the advert and says which line, because no span means no requirement', () => {
    const lines = NURSING_JD.split('\n');
    for (const requirement of found) {
      expect(requirement.line).toBeGreaterThan(0);
      expect(lines[requirement.line - 1]).toContain(requirement.text);
    }
  });

  it('finds nothing in an advert that only sounds legal', () => {
    expect(eligibilityRequirements(LEGAL_SOUNDING_JD)).toEqual([]);
  });

  it('reads a clearance and a chartered status as eligibility, and leaves the engineering alone', () => {
    const kinds = eligibilityRequirements(CLEARED_JD).map((r) => r.kind);
    expect(kinds).toContain('clearance');
    const texts = eligibilityRequirements(CLEARED_JD).map((r) => r.text).join('\n');
    expect(texts).not.toContain('model-based systems engineering');
  });

  it('gives every requirement its own id', () => {
    const ids = found.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('files the offer-conditions sentence as boilerplate, not as something to check', () => {
    expect(sectionOfLineContaining(NURSING_JD, 'All offers are subject to')).toBe('boilerplate');
  });
});

describe('reading a CV against an eligibility requirement', () => {
  const requirements = eligibilityRequirements(NURSING_JD);
  const CV_WITH = `Jordan Blake
Registered Nurse

Experience
Senior Staff Nurse, respiratory ward, 2018 to present.
Ran a nurse-led clinic one day a week.

Education
BSc Nursing.

Certifications
NMC registration, active.`;
  const CV_WITHOUT = `Jordan Blake

Experience
Operations coordinator, 2019 to present.
Scheduled clinic appointments and chased outcomes.`;

  it('quotes the CV line where there is one', () => {
    const reads = readEligibility(requirements, extractCvFacts(CV_WITH));
    const registration = reads.find((r) => r.kind === 'registration');
    expect(registration!.evidence.length).toBeGreaterThan(0);
    expect(registration!.evidence.map((e) => e.quote).join(' ')).toMatch(/NMC/i);
  });

  it('says Questor could not see it, never that the candidate lacks it', () => {
    const reads = readEligibility(requirements, extractCvFacts(CV_WITHOUT));
    const silent = reads.filter((r) => r.evidence.length === 0);
    expect(silent.length).toBeGreaterThan(0);
    for (const read of silent) {
      expect(read.note).toMatch(/not evidence/i);
      expect(read.note).not.toMatch(/\b(lacks|does not have|missing|fails|unqualified|ineligible)\b/i);
    }
  });

  it('leaves the decision with a person in so many words', () => {
    const reads = readEligibility(requirements, extractCvFacts(CV_WITH));
    for (const read of reads) expect(read.note.length).toBeGreaterThan(40);
    expect(reads.every((r) => r.requirement.length > 0)).toBe(true);
  });

  it('reads nothing when the role names no eligibility requirement', () => {
    expect(readEligibility([], extractCvFacts(CV_WITH))).toEqual([]);
  });
});

describe('eligibility and the fit score', () => {
  const role: RoleSuccessProfile = {
    roleContext: 'Clinical Nurse Specialist',
    outcomes: ['Run a nurse-led respiratory clinic'],
    responsibilities: ['Review inhaler technique with every patient'],
    competencies: [{
      id: 'c1', name: 'Clinical & Patient Care', definition: 'Patient-facing clinical work.',
      category: 'domain', classification: 'essential', weight: 1, requiredLevel: 3, targetLevel: 4,
      indicators: ['Runs a clinic'], evidenceModes: ['behavioral_example'],
    }],
    scoringRules: { mustPassCompetencyIds: ['c1'], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: '' },
    redFlags: [],
    seniority: 'Senior',
  };
  const facts = extractCvFacts('Experience\nRan a nurse-led clinic and reviewed inhaler technique.\n\nCertifications\nNMC registration, active.');

  it('does not move the number, the band or any component', () => {
    const without = scoreFit(facts, role).fit;
    const with_ = scoreFit(facts, { ...role, eligibility: eligibilityRequirements(NURSING_JD) }).fit;
    expect(with_.overall).toBe(without.overall);
    expect(with_.band).toBe(without.band);
    expect(with_.coverage).toBe(without.coverage);
    expect(with_.components).toEqual(without.components);
  });

  it('still carries the reading, so HR sees it beside the score it did not affect', () => {
    const fit = scoreFit(facts, { ...role, eligibility: eligibilityRequirements(NURSING_JD) }).fit;
    expect(fit.eligibility?.length).toBe(3);
    expect(fit.components.some((c) => c.key === 'eligibility')).toBe(false);
  });

  it('leaves the stored shape untouched on a role that names none', () => {
    expect(scoreFit(facts, role).fit.eligibility).toBeUndefined();
  });
});
