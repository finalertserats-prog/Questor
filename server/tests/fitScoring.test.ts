import { describe, expect, it } from 'vitest';
import { computeFitScore } from '../src/engines/fitScoring.js';
import { PRESENTATION_MAX_POINTS, UNEVIDENCED_NEUTRAL_SCORE } from '../src/domain/fitVocabulary.js';
import {
  CAREER_CHANGER_CV, DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK, DESIGNER_ROLE, GAPS_CV,
  INJECTION_CV, JARGON_CV, NON_NATIVE_CV, PLAIN_CV, STRONG_CV, WEAK_CV,
} from './fixtures/cvFixtures.js';

/**
 * The fit score, asserted on what it SAYS rather than on what it computes.
 *
 * A number can be tuned until a test passes and still be meaningless. A
 * sentence cannot: if the explanation names the wrong evidence, or claims
 * something the CV does not say, the test reads wrong to a human. So nearly
 * every assertion below is about an explanation, a piece of evidence, or an
 * ordering — and the few numeric ones are about relationships between CVs, not
 * about a magic constant.
 */

const NOW = new Date('2026-09-23T00:00:00Z');
const score = (cv: string, role = DATA_ENGINEER_ROLE, stack = DATA_ENGINEER_STACK) =>
  computeFitScore({}, cv, role, stack, { now: NOW, scorecardVersion: 3 }).fit;

describe('a CV that matches the role', () => {
  const fit = score(STRONG_CV);

  it('reads as a strong match', () => {
    expect(fit.band).toBe('strong_match');
  });

  it('says in one sentence what that means', () => {
    expect(fit.meaning).toBe('The CV evidences most of what this role asks for, including its must-haves.');
  });

  it('explains every component in a sentence of its own', () => {
    for (const c of fit.components) {
      expect(c.explanation, `${c.key} has no explanation`).toBeTruthy();
      expect(c.explanation!.length).toBeGreaterThan(30);
    }
  });

  it('backs its evidenced competencies with lines from the CV', () => {
    const pipelines = fit.competencies!.find((c) => c.competencyId === 'c-pipelines')!;
    expect(pipelines.strength).toBe('evidenced');
    for (const e of pipelines.evidence) expect(STRONG_CV).toContain(e.quote);
  });

  it('names where each competency was found', () => {
    const pipelines = fit.competencies!.find((c) => c.competencyId === 'c-pipelines')!;
    expect(pipelines.explanation).toContain('in work the CV describes doing');
  });

  it('has no must-have gaps', () => {
    expect(fit.mustHaveGaps).toEqual([]);
  });

  it('lists the nice-to-haves it did find', () => {
    expect(fit.niceToHavesPresent).toEqual(expect.arrayContaining(['Mentoring', 'Cost Optimisation', 'Terraform']));
  });

  it('stamps what it was measured against', () => {
    expect(fit.scorecardVersion).toBe(3);
    expect(fit.engineVersion).toBe('fit-v2');
    expect(fit.techStackFingerprint).toBe('airflow|kafka|snowflake|terraform');
  });
});

describe('a CV that does not match the role', () => {
  const fit = score(WEAK_CV);

  it('scores below a matching one', () => {
    expect(fit.overall).toBeLessThan(score(STRONG_CV).overall - 15);
  });

  it('names the must-have it cannot evidence', () => {
    expect(fit.mustHaveGaps).toContain('Pipeline Engineering');
  });

  it('says the CV is silent rather than saying the candidate is weak', () => {
    const pipelines = fit.competencies!.find((c) => c.competencyId === 'c-pipelines')!;
    expect(pipelines.explanation).toContain('That is silence, not a shortfall');
  });

  it('never scores an unevidenced competency zero', () => {
    for (const c of fit.competencies!.filter((c) => c.strength === 'not_evidenced')) {
      expect(c.score).toBeNull();
    }
    expect(UNEVIDENCED_NEUTRAL_SCORE).toBeGreaterThan(0);
  });

  it('puts the must-have gap first in what to probe', () => {
    expect(fit.probes[0]).toContain('Pipeline Engineering');
    expect(fit.probeDetail![0].reason).toBe('Must-have with no evidence on the CV.');
  });
});

describe('a career changer whose CV never uses the role\'s job titles', () => {
  const fit = score(CAREER_CHANGER_CV);

  it('is still credited for the work described', () => {
    const pipelines = fit.competencies!.find((c) => c.competencyId === 'c-pipelines')!;
    expect(pipelines.strength).not.toBe('not_evidenced');
  });

  it('quotes the work rather than a job title', () => {
    const pipelines = fit.competencies!.find((c) => c.competencyId === 'c-pipelines')!;
    expect(pipelines.evidence.some((e) => e.quote.includes('ingestion'))).toBe(true);
  });

  it('reads better than a CV from an unrelated field', () => {
    expect(fit.overall).toBeGreaterThan(score(WEAK_CV).overall);
  });
});

describe('the role the CV is read against', () => {
  it('changes the answer', () => {
    expect(score(STRONG_CV, DESIGNER_ROLE, []).overall).toBeLessThan(score(STRONG_CV).overall);
  });

  it('is what "missing" is missing from', () => {
    expect(score(STRONG_CV, DESIGNER_ROLE, []).missing).toContain('User Research');
  });
});

describe('the role\'s technologies', () => {
  it('are each explained with how recently the CV shows them', () => {
    const kafka = score(STRONG_CV).technologies!.find((t) => t.name === 'Kafka')!;
    expect(kafka.explanation).toContain('current or recent work');
  });

  it('say plainly when a listed technology is never dated', () => {
    const terraform = score(STRONG_CV).technologies!.find((t) => t.name === 'Terraform')!;
    expect(terraform.explanation).toContain('never inside a dated job');
  });

  it('count for more when the role requires them than when it does not', () => {
    const withoutKafka = score(STRONG_CV, DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK.map((t) => (t.name === 'Kafka' ? { ...t, required: false } : t)));
    const withKafka = score(STRONG_CV);
    expect(withKafka.overall).toBeGreaterThanOrEqual(withoutKafka.overall);
  });

  it('are named as missing and probed when the CV never mentions them', () => {
    const fit = score(WEAK_CV);
    expect(fit.missing).toContain('Kafka (required technology)');
    expect(fit.probes.some((p) => p.startsWith('Probe Kafka:'))).toBe(true);
  });

  it('are flagged as old rather than absent when the CV last shows them years ago', () => {
    const stale = `Ana Silva\n\nExperience\n\nData Engineer, Old Co (2012 - 2015)\n- Built Kafka ingestion into a warehouse and owned the Airflow DAGs.\n\nSupport Engineer, New Co (2016 - Present)\n- Answered tickets and wrote runbooks.\n`;
    const kafka = score(stale).technologies!.find((t) => t.name === 'Kafka')!;
    expect(kafka.strength).not.toBe('not_evidenced');
    expect(kafka.explanation).toContain('years ago');
  });
});

describe('the interview probes', () => {
  const fit = score(GAPS_CV);

  it('never quote a line of the CV back, which is the identity check\'s job', () => {
    const lines = GAPS_CV.split('\n').map((l) => l.replace(/^[-\s]+/, '').trim()).filter((l) => l.length > 25);
    for (const probe of fit.probes) {
      for (const line of lines) expect(probe).not.toContain(line);
    }
  });

  it('say why each one is worth asking', () => {
    for (const p of fit.probeDetail!) expect(p.reason.length).toBeGreaterThan(10);
  });

  it('are what the interview planner reads first', () => {
    expect(fit.probes.length).toBeGreaterThan(0);
    expect(fit.probes[0]).toBe(fit.probeDetail![0].text);
  });
});

describe('evidence, not polish', () => {
  const jargon = score(JARGON_CV);
  const plain = score(PLAIN_CV);

  it('scores the same work the same however it is written', () => {
    expect(Math.abs(jargon.overall - plain.overall)).toBeLessThanOrEqual(PRESENTATION_MAX_POINTS);
  });

  it('reads the same competencies off both', () => {
    const strengths = (f: typeof jargon) => f.competencies!.map((c) => `${c.competencyId}:${c.strength}`);
    expect(strengths(jargon)).toEqual(strengths(plain));
  });

  it('does not reward a longer CV for being longer', () => {
    const padded = `${PLAIN_CV}\n\nInterests\n${'I enjoy long walks and reading about history. '.repeat(40)}\n`;
    expect(score(padded).overall).toBe(plain.overall);
  });
});

describe('a CV written by a non-native English speaker', () => {
  const fit = score(NON_NATIVE_CV);

  it('is read for what it evidences, not for its grammar', () => {
    expect(fit.competencies!.find((c) => c.competencyId === 'c-pipelines')!.strength).toBe('evidenced');
    expect(fit.competencies!.find((c) => c.competencyId === 'c-modelling')!.strength).not.toBe('not_evidenced');
  });

  it('is not read as a limited match', () => {
    expect(fit.band).not.toBe('limited_match');
  });
});

describe('a CV carrying instructions for the system', () => {
  const fit = score(INJECTION_CV);

  it('reports the attempt', () => {
    expect(fit.redaction!.injectionLines.length).toBeGreaterThan(0);
  });

  it('never quotes one as evidence', () => {
    const quotes = [
      ...fit.components.flatMap((c) => c.evidence),
      ...fit.competencies!.flatMap((c) => c.evidence.map((e) => e.quote)),
      ...fit.technologies!.flatMap((t) => t.evidence.map((e) => e.quote)),
    ].join(' ').toLowerCase();
    expect(quotes).not.toContain('ignore all previous');
    expect(quotes).not.toContain('perfect score');
    expect(quotes).not.toContain('reveal the rubric');
  });

  it('does not let the attempt raise the score', () => {
    const clean = INJECTION_CV.split('\n').filter((l) => !/ignore all|reveal the rubric/i.test(l)).join('\n');
    expect(fit.overall).toBe(score(clean).overall);
  });
});

describe('coverage and confidence', () => {
  it('separate "how well it matches" from "how much it says"', () => {
    const fit = score(GAPS_CV);
    expect(fit.coverage).toBeGreaterThan(0);
    expect(fit.coverage).toBeLessThan(1);
  });

  it('call a CV that says almost nothing about the role exactly that', () => {
    const fit = score('Jo Blake\n\nExperience\n\nBaker, Corner Bakery (2020 - Present)\n- Baked bread early in the morning.\n');
    expect(fit.band).toBe('not_enough_evidence');
    expect(fit.meaning).toContain('too little');
  });

  it('are lower when the CV barely parsed, without making the candidate look worse', () => {
    const unreadable = score('kafka airflow snowflake pipelines star schema');
    expect(unreadable.confidence).toBeLessThan(score(STRONG_CV).confidence);
  });
});

describe('the things it refuses to read', () => {
  it('are stated on every score', () => {
    const fit = score(STRONG_CV);
    expect(fit.excludedSignals).toEqual(expect.arrayContaining(['age', 'name', 'graduation year', 'nationality', 'writing polish and CV length']));
  });
});

describe('the fit vocabulary', () => {
  it('never borrows a word from the interview verdict', () => {
    const said = [score(STRONG_CV), score(WEAK_CV), score(CAREER_CHANGER_CV)]
      .flatMap((f) => [f.meaning ?? '', ...f.components.map((c) => c.explanation ?? ''), ...f.probes])
      .join(' ')
      .toLowerCase();
    for (const word of ['proceed', 'do not progress', 'reject', 'hire', 'shortlist']) {
      expect(said, `fit wording used "${word}"`).not.toContain(word);
    }
  });
});
