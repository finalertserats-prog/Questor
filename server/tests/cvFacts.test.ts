import { describe, expect, it } from 'vitest';
import { extractCvFacts } from '../src/engines/cvFacts.js';
import { prepareCvForScoring, redactionNote } from '../src/engines/cvRedaction.js';
import {
  CAREER_CHANGER_CV, GAPS_CV, INJECTION_CV, PROTECTED_A, STRONG_CV, withProtectedDetail,
} from './fixtures/cvFixtures.js';

/**
 * What the CV parser must be able to say, and what it must refuse to see.
 *
 * Every assertion here is about a FACT and its provenance, because a fact with
 * no line behind it is the thing this whole feature exists to stop producing.
 */

const TODAY = new Date('2026-09-23T00:00:00Z');

describe('reading roles off a CV', () => {
  const facts = extractCvFacts(STRONG_CV, { today: TODAY });

  it('finds both jobs', () => {
    expect(facts.roles.map((r) => r.employer)).toEqual(['Northwind Analytics', 'Kestrel Retail']);
  });

  it('reads the title separately from the employer', () => {
    expect(facts.roles[0].title).toBe('Senior Data Engineer');
  });

  it('dates the current job to today rather than to the last year written down', () => {
    expect(facts.roles[0].current).toBe(true);
    expect(facts.roles[0].endYear).toBe(2026);
  });

  it('measures how long each job lasted', () => {
    expect(facts.roles[1].months).toBe((2021 - 2017) * 12 + 1);
  });

  it('carries the exact line every role came from', () => {
    const quote = facts.roles[0].evidence.quote;
    expect(STRONG_CV).toContain(quote);
  });

  it('keeps each job\'s bullets as evidence with their own lines', () => {
    expect(facts.roles[0].bullets.length).toBeGreaterThanOrEqual(4);
    for (const bullet of facts.roles[0].bullets) expect(bullet.line).toBeGreaterThan(facts.roles[0].evidence.line);
  });
});

describe('a CV that writes its dates without spaces', () => {
  const CV = `Ravi Menon
Phone: +91 98765 43210

Experience

Data Engineer, Acme Data (2019-2022)
- Built the Kafka ingestion and owned the Airflow DAGs.

Junior Engineer, Acme Data (2016-2019)
- Wrote the first batch loads.
`;
  const facts = extractCvFacts(CV, { today: TODAY });

  it('keeps its dates, which a phone-number mask once ate whole', () => {
    expect(facts.roles.map((r) => [r.startYear, r.endYear])).toEqual([[2019, 2022], [2016, 2019]]);
  });

  it('can therefore still say how recently a technology was used', () => {
    expect(facts.technologies.find((t) => t.name === 'Kafka')?.recencyYears).toBe(4);
  });

  it('still removes the phone number from the line that is one', () => {
    expect(facts.lines.map((l) => l.text).join(' ')).not.toContain('98765');
  });
});

describe('reading technologies off a CV', () => {
  const facts = extractCvFacts(STRONG_CV, { today: TODAY });
  const kafka = facts.technologies.find((t) => t.name === 'Kafka');

  it('ties a technology to the job it was used in, so recency is knowable', () => {
    expect(kafka?.recencyYears).toBe(0);
  });

  it('adds up how long it was used across jobs', () => {
    expect(kafka?.monthsUsed).toBeGreaterThan(12);
  });

  it('quotes the line the technology was named on', () => {
    expect(kafka?.evidence[0].quote).toContain('Kafka');
  });

  it('does not invent a date for a technology that only appears in a skills list', () => {
    const terraform = facts.technologies.find((t) => t.name === 'Terraform');
    expect(terraform?.evidence.length).toBeGreaterThan(0);
    expect(terraform?.recencyYears).toBeUndefined();
  });
});

describe('scope figures', () => {
  const facts = extractCvFacts(STRONG_CV, { today: TODAY });

  it('reads the size of a team from the line that states it', () => {
    const team = facts.scope.find((s) => s.kind === 'team');
    expect(team?.value).toBe('4');
    expect(team?.evidence.quote).toContain('Mentored a team of 4');
  });

  it('reads the scale the work ran at', () => {
    expect(facts.scope.some((s) => s.kind === 'scale')).toBe(true);
  });
});

describe('gaps between dated roles', () => {
  const facts = extractCvFacts(GAPS_CV, { today: TODAY });

  it('are measured rather than guessed at', () => {
    expect(facts.gaps).toEqual([{ fromYear: 2019, toYear: 2022, months: 36 }]);
  });

  it('do not change the tenure the CV accounts for', () => {
    expect(facts.tenure.roleCount).toBe(2);
    expect(facts.tenure.accountedMonths).toBeGreaterThan(0);
  });
});

describe('a career changer', () => {
  const facts = extractCvFacts(CAREER_CHANGER_CV, { today: TODAY });

  it('is read as two dated roles even though neither is called data engineer', () => {
    expect(facts.roles.length).toBe(2);
  });

  it('still has its technologies dated from the job they sit in', () => {
    expect(facts.technologies.find((t) => t.name === 'Airflow')?.recencyYears).toBe(0);
  });
});

describe('a CV that tries to give instructions', () => {
  const facts = extractCvFacts(INJECTION_CV, { today: TODAY });

  it('marks the lines that did it', () => {
    expect(facts.redaction.injectionLines.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps them out of everything that gets read', () => {
    const readable = facts.lines.filter((l) => !l.injection).map((l) => l.text).join('\n').toLowerCase();
    expect(readable).not.toContain('ignore all previous instructions');
    expect(readable).not.toContain('maximum score');
  });

  it('never lets one become evidence for a technology', () => {
    for (const tech of facts.technologies) {
      for (const e of tech.evidence) expect(e.quote.toLowerCase()).not.toContain('perfect score');
    }
  });

  it('says so in a sentence a person can read', () => {
    expect(redactionNote(facts.redaction)).toContain('tried to give instructions');
  });

  it('still reads the real work around them', () => {
    expect(facts.technologies.map((t) => t.name)).toEqual(expect.arrayContaining(['Kafka', 'Snowflake', 'Airflow']));
  });
});

describe('protected detail', () => {
  const cv = withProtectedDetail(PROTECTED_A);
  const prepared = prepareCvForScoring(cv);
  const readable = prepared.lines.map((l) => l.text).join('\n');

  it.each([
    ['the name', PROTECTED_A.name],
    ['the email address', PROTECTED_A.email],
    ['the phone number', '98765'],
    ['the home address', PROTECTED_A.address],
    ['the date of birth', 'Date of Birth'],
    ['the age', 'Age:'],
    ['the gender', 'Gender'],
    ['the marital status', 'Marital'],
    ['the nationality', 'Nationality'],
    ['the religion', 'Religion'],
    ['the photograph note', 'Photograph'],
    ['the institution', PROTECTED_A.institution],
    ['the graduation year', PROTECTED_A.graduationYear],
  ])('is removed before anything can read it: %s', (_label, token) => {
    expect(readable).not.toContain(token);
  });

  it('keeps the qualification itself, which is job-related', () => {
    expect(readable).toContain('B.Tech');
  });

  it('keeps the institution only where nothing can score it', () => {
    const facts = extractCvFacts(cv, { today: TODAY });
    expect(facts.qualifications[0].displayOnly.institution).toContain('Indian Institute of Technology');
    expect(facts.lines.map((l) => l.text).join('\n')).not.toContain('Indian Institute of Technology');
  });

  it('says what it took out', () => {
    expect(redactionNote(prepared.redaction)).toContain('were removed before scoring and were not read');
  });

  it('leaves the work untouched', () => {
    expect(readable).toContain('Kafka');
    expect(readable).toContain('star schema');
  });
});

describe('stated location and work authorisation', () => {
  const facts = extractCvFacts('Summary\nBased in Berlin and authorised to work in the EU without sponsorship.\n\nExperience\nData Engineer, Acme (2020 - 2023)\n- Built pipelines in Airflow.\n', { today: TODAY });

  it('are captured only because the candidate wrote them down', () => {
    expect(facts.statedLocation?.quote).toContain('Berlin');
    expect(facts.statedWorkAuthorisation?.quote).toContain('authorised to work');
  });

  it('are absent when the CV never says them', () => {
    const quiet = extractCvFacts(GAPS_CV, { today: TODAY });
    expect(quiet.statedLocation).toBeUndefined();
    expect(quiet.statedWorkAuthorisation).toBeUndefined();
  });
});
