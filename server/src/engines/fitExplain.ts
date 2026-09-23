import type { FitCompetencyRead, FitProbe } from '../domain/types.js';
import type { CvFacts, CvScopeKind } from '../domain/cvFacts.js';
import type { FitStrength } from '../domain/fitVocabulary.js';
import type { BandId, ExperienceBand } from './experienceBands.js';
import { RECENT_YEARS, STALE_YEARS, type EvidenceHit, type TechnologyReading } from './fitEvidence.js';
import { looksFragmented } from '../domain/cvFacts.js';

/**
 * Every part of a fit score, said in one sentence a person can check.
 *
 * The rule the whole feature rests on: if a number cannot be explained in a
 * sentence that names its evidence, it is not shown. That is what makes this
 * safe to put in front of a hiring manager, and it is also what makes it
 * arguable — HR can read a sentence and disagree with it, which they cannot do
 * with a bar.
 *
 * Two things these sentences never do. They never quote a CV line back as a
 * question: the identity lane already asks CV-anchored questions
 * (engines/cvAnchors.ts), and two features quoting the same lines would make an
 * interview feel like an interrogation. These probes name what the ROLE asks
 * for and leave the candidate's own words to that feature. And they never
 * describe the person — only what the document does or does not show.
 */

export function competencySentence(name: string, strength: FitStrength, hits: readonly EvidenceHit[]): string {
  if (strength === 'not_evidenced') {
    return `The CV does not mention ${name}. That is silence, not a shortfall — the interview is where it gets checked.`;
  }
  const where = hits[0]?.evidence.section === 'experience' ? 'in work the CV describes doing'
    : hits[0]?.evidence.section === 'projects' ? 'in a project the CV describes'
    : hits[0]?.evidence.section === 'skills' ? 'in a skills list, which is a claim rather than an account of doing it'
    : 'on the CV';
  return strength === 'evidenced'
    ? `${name} is evidenced ${where}, across ${hits.length} line${hits.length === 1 ? '' : 's'}.`
    : `${name} appears ${where}, but only once, so it reads as claimed rather than shown.`;
}

export function technologySentence(r: TechnologyReading, band: BandId): string {
  const asked = r.item.required ? 'required by this role' : 'listed as nice to have';
  if (r.strength === 'not_evidenced') {
    return `${r.item.name} is ${asked} and never appears on the CV.`;
  }
  const years = r.recencyYears;
  const depth = r.monthsUsed && r.monthsUsed >= 12 ? ` for about ${Math.round(r.monthsUsed / 12)} year${r.monthsUsed >= 24 ? 's' : ''}` : '';
  if (years === null) {
    return `${r.item.name} is ${asked} and is named on the CV, but never inside a dated job, so how recently or how long it was used is not knowable from this document.`;
  }
  if (years <= RECENT_YEARS) {
    const shallow = band !== 'emerging' && band !== 'developing' && (r.item.level === 'strong' || r.item.level === 'expert') && (r.monthsUsed ?? 0) > 0 && (r.monthsUsed ?? 0) < 12;
    return shallow
      ? `${r.item.name} is ${asked} at ${r.item.level} depth and is current, but the CV shows under a year of it.`
      : `${r.item.name} is ${asked} and the CV shows it in current or recent work${depth}.`;
  }
  if (years <= STALE_YEARS) return `${r.item.name} is ${asked} and the CV last shows it about ${years} years ago${depth}.`;
  return `${r.item.name} is ${asked} but the CV last shows it ${years} years ago, which is old enough to be worth asking about.`;
}

const SCOPE_WORD: Readonly<Record<CvScopeKind, string>> = {
  team: 'the size of a team they led',
  budget: 'a budget they held',
  revenue: 'revenue they were responsible for',
  scale: 'the scale the work ran at',
};

export function experienceSentence(band: ExperienceBand, met: readonly string[], needs: readonly string[], facts: CvFacts): string {
  if (needs.length === 0) {
    return facts.scope.length > 0
      ? `This role is pitched at ${band.label}, where the question is craft rather than span, and the CV does state ${facts.scope.map((s) => SCOPE_WORD[s.kind]).slice(0, 2).join(' and ')}.`
      : `This role is pitched at ${band.label}, where the question is craft rather than span, so nothing is held against a CV that states no team size or budget.`;
  }
  const missing = needs.filter((n) => !met.includes(n)) as CvScopeKind[];
  if (missing.length === 0) {
    return `This role is pitched at ${band.label}, and the CV states ${needs.map((n) => SCOPE_WORD[n as CvScopeKind]).join(' and ')}.`;
  }
  return `This role is pitched at ${band.label}, and the CV does not state ${missing.map((n) => SCOPE_WORD[n]).join(' or ')} — worth asking about, since a CV often leaves scope out.`;
}

/** A neutral, one-line note on tenure shape. Never a judgement, and never scored. */
export function tenureNote(facts: CvFacts): string | null {
  const notes: string[] = [];
  if (looksFragmented(facts.tenure)) {
    notes.push(`The CV shows ${facts.tenure.roleCount} roles with a median of about ${Math.round((facts.tenure.medianRoleMonths ?? 0) / 12 * 10) / 10} years each. There are good reasons for that and bad ones, and the CV does not say which.`);
  }
  if (facts.gaps.length > 0) {
    notes.push(`There ${facts.gaps.length === 1 ? 'is a gap' : `are ${facts.gaps.length} gaps`} between dated roles. Gaps are not scored and are not a concern on their own.`);
  }
  return notes.length ? notes.join(' ') : null;
}

// --- Probes ---------------------------------------------------------------------

export interface ProbeInput {
  readonly reads: readonly FitCompetencyRead[];
  readonly readings: readonly TechnologyReading[];
  readonly roleBand: BandId;
}

/**
 * What the interview should check, most valuable first.
 *
 * The order is the point. The planner takes the first one as the intent of the
 * resume-validation block (engines/interviewPlanner.ts), so the thing that most
 * needs checking has to be at the top: a must-have with nothing behind it beats
 * a nice-to-have that is merely thin.
 */
export function buildProbes(input: ProbeInput): FitProbe[] {
  const probes: FitProbe[] = [];
  const seen = new Set<string>();
  const add = (p: FitProbe) => {
    const key = p.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(p);
  };

  for (const r of input.reads.filter((r) => r.mustHave && r.strength === 'not_evidenced')) {
    add({
      text: `Probe ${r.name}: this role treats ${r.name} as a must-have and the CV does not evidence it. Ask for one piece of work where they had to do it, and what they personally decided.`,
      reason: 'Must-have with no evidence on the CV.',
      competencyId: r.competencyId,
    });
  }

  for (const t of input.readings.filter((t) => t.item.required && t.strength === 'not_evidenced')) {
    add({
      text: `Probe ${t.item.name}: ask how they have used ${t.item.name} in real work, or what they have used in its place and how it compares.`,
      reason: 'Required technology the CV never names.',
      technology: t.item.name,
    });
  }

  for (const t of input.readings.filter((t) => t.item.required && t.strength !== 'not_evidenced' && (t.recencyYears ?? 0) > STALE_YEARS)) {
    add({
      text: `Probe ${t.item.name}: the CV last shows ${t.item.name} several years ago. Ask what they have done with it since, and what has changed about it.`,
      reason: 'Required technology last evidenced years ago.',
      technology: t.item.name,
    });
  }

  for (const r of input.reads.filter((r) => !r.mustHave && r.classification === 'essential' && r.strength === 'not_evidenced')) {
    add({
      text: `Probe ${r.name}: the CV is silent on ${r.name}, which this role treats as essential. Ask for a concrete example rather than an opinion.`,
      reason: 'Essential competency the CV does not mention.',
      competencyId: r.competencyId,
    });
  }

  for (const t of input.readings.filter((t) => t.item.required && t.strength !== 'not_evidenced' && t.recencyYears === null)) {
    add({
      text: `Probe ${t.item.name}: ${t.item.name} is listed but never inside a dated job. Ask where and for how long they used it.`,
      reason: 'Required technology named only in a list.',
      technology: t.item.name,
    });
  }

  for (const r of input.reads.filter((r) => r.strength === 'partial')) {
    add({
      text: `Probe ${r.name}: the CV mentions ${r.name} once. Ask for a second example, and for what they would do differently now.`,
      reason: 'Claimed once on the CV, with nothing behind it yet.',
      competencyId: r.competencyId,
    });
  }

  return probes.slice(0, 12);
}
