import { describe, expect, it } from 'vitest';
import { extractCvFacts } from '../src/engines/cvFacts.js';
import { cvReadability, hasReadableText } from '../src/domain/cvReadability.js';
import { needsHumanReading, parseQualityOf, worstSeverity, type CvParseQuality } from '../src/domain/cvParseQuality.js';
import type { CvFacts } from '../src/domain/cvFacts.js';
import { CORPUS_TODAY, CV_CORPUS, corpusText } from './fixtures/cv/corpus.js';

/**
 * What the reading says about itself.
 *
 * The defect underneath all three reported failures is the same one: the
 * parser was honest about what it read and silent about what it missed. A
 * German CV with two jobs on it produced "1 role read from the CV — nothing
 * flagged", with every fact marked as read. Nothing on the screen
 * distinguished a CV with one job from a CV whose second job we could not
 * see, and confident silence is worse than a visible gap, because a gap gets
 * checked.
 *
 * Two constraints this file enforces as hard as it enforces the flags
 * themselves:
 *
 *  - No flag may read as a judgement about the candidate. "Could not verify
 *    current employment" makes the person the suspect for a failing of ours.
 *  - No flag may fire without a reason it can point at. A warning on every CV
 *    is a warning on none, and the recruiter who learns to click past it will
 *    click past the one that mattered.
 */

/** Every parse this file makes records a quality; absence is a bug, not a pass. */
const qualityOf = (facts: CvFacts): CvParseQuality => {
  const quality = parseQualityOf(facts);
  if (!quality) throw new Error('The parse recorded no quality assessment at all');
  return quality;
};

const factsFor = (id: string) => {
  const fixture = CV_CORPUS.find((c) => c.id === id);
  if (!fixture) throw new Error(`No fixture ${id}`);
  return extractCvFacts(corpusText(fixture), { today: CORPUS_TODAY });
};

const qualityFor = (id: string) => {
  const quality = parseQualityOf(factsFor(id));
  if (!quality) throw new Error(`No parse quality recorded for ${id}`);
  return quality;
};

const codesFor = (id: string) => qualityFor(id).flags.map((f) => f.code);

describe('a document that is not a CV', () => {
  const NOISE = CV_CORPUS.find((c) => c.id === 'noise-dashes')!;

  it('has no readable text in it, however much punctuation it has', () => {
    expect(hasReadableText(corpusText(NOISE))).toBe(false);
  });

  it('is refused rather than read', () => {
    const quality = qualityFor('noise-dashes');
    expect(quality.readable).toBe(false);
    expect(quality.flags.map((f) => f.code)).toEqual(['not_a_cv']);
    expect(worstSeverity(quality)).toBe('blocking');
  });

  it('produces no roles and no technologies to build a score from', () => {
    const facts = factsFor('noise-dashes');
    expect([facts.roles.length, facts.technologies.length]).toEqual([0, 0]);
  });

  it('tells the uploader what to do, without saying anything about a candidate', () => {
    const [flag] = qualityFor('noise-dashes').flags;
    expect(flag.message).toMatch(/could not be read as a CV/i);
    expect(flag.message).toMatch(/paste the CV text/i);
  });

  it('still accepts a short but genuine CV', () => {
    const cv = [
      'Amelia Stone', 'EXPERIENCE',
      'Analyst, Orbit Retail  2019 - 2022',
      'Ran the weekly reporting pack for the buying team.',
      'EDUCATION', 'BSc Economics, 2019',
    ].join('\n');
    expect(hasReadableText(cv)).toBe(true);
  });

  it('measures words and ink rather than length, so a dense CV is never refused', () => {
    const dense = 'Engineer 2019-2022 Python SQL Kafka '.repeat(6);
    expect(cvReadability(dense).readable).toBe(true);
  });

  it('does not refuse a CV written in a script that has no spaces', () => {
    // `\p{L}{2,}` counts runs of letters, and Chinese writes without gaps, so
    // a whole page comes back as a handful of "words". A word floor alone
    // would refuse a good CV for the script it is written in.
    const chinese = [
      '姓名：李伟，数据工程师，北京',
      '工作经历',
      '二零二一年三月至今，高级数据工程师，北方数据有限公司，北京',
      '负责数据质量与监控，使用 Python 与 SQL 构建每日批处理任务',
      '二零一七年八月至二零二一年二月，数据工程师，东方信息技术公司',
      '负责数据仓库建模与报表开发，参与实时数据平台建设',
      '教育背景',
      '计算机科学硕士，二零一七年',
      '技能：Python、SQL、Kafka、Airflow、Snowflake',
    ].join('\n');
    const measured = cvReadability(chinese);
    expect([measured.readable, measured.reason]).toEqual([true, undefined]);
  });

  it('separates "there is no writing here" from "there is not much of it"', () => {
    // The length floor belongs on the upload path, where a near-empty file
    // means extraction failed. A recruiter pasting four lines has decided
    // that is the CV, and a short CV was never a defect.
    const short = cvReadability('Amelia Stone, analyst at Orbit Retail since 2019.');
    expect([short.readable, short.prose, short.reason]).toEqual([false, true, 'too_few_words']);
    const rules = cvReadability(corpusText(NOISE));
    expect([rules.readable, rules.prose, rules.reason]).toEqual([false, false, 'not_prose']);
  });
});

describe('a CV that reads cleanly', () => {
  it('raises nothing at all', () => {
    for (const id of ['en-standard', 'de-heute', 'fr-aujourdhui', 'es-actualidad', 'en-uk-dayfirst', 'en-two-column', 'en-real-gap']) {
      expect(codesFor(id), id).toEqual([]);
    }
  });

  it('does not ask for a human', () => {
    expect(needsHumanReading(qualityFor('en-standard'))).toBe(false);
  });

  it('does not flag a declared career break as a line it failed to read', () => {
    // The candidate wrote the break down, with dates. The reading understood
    // it and deliberately did not count it as a job, which is the opposite of
    // missing it — flagging it would penalise the honesty.
    expect(codesFor('en-real-gap')).toEqual([]);
  });
});

describe('a CV whose headings nobody taught it', () => {
  it('says the reading worked from the layout', () => {
    expect(codesFor('en-unknown-heading')).toContain('headings_not_recognised');
  });

  it('says it as context rather than as a problem with the candidate', () => {
    const flag = qualityFor('en-unknown-heading').flags.find((f) => f.code === 'headings_not_recognised')!;
    expect(flag.severity).toBe('note');
    expect(flag.message).toMatch(/section headings were recognised/i);
    expect(flag.message).toMatch(/worked from the layout/i);
    expect(flag.message).toMatch(/check the roles/i);
  });
});

describe('a scan that lost its characters', () => {
  it('says no work history could be read, rather than reporting none', () => {
    expect(codesFor('en-scanned-sparse')).toContain('no_work_history_read');
  });

  it('asks for a person', () => {
    expect(needsHumanReading(qualityFor('en-scanned-sparse'))).toBe(true);
  });
});

describe('a dated line the reading could not use', () => {
  const cv = [
    'EXPERIENCE',
    'Senior Engineer, Northwind  Mar 2019 - Feb 2022',
    'Ran the payments platform.',
    // A scan that turned the zero of "2018" into a letter O. The line is
    // plainly dated to a person and unreadable to the parser, which is
    // exactly the gap this flag measures.
    'Engineer, Northwind  2015 - 2O18',
    'Wrote the original service.',
  ].join('\n');

  it('is counted and named', () => {
    const quality = qualityOf(extractCvFacts(cv, { today: CORPUS_TODAY }));
    const flag = quality.flags.find((f) => f.code === 'dated_lines_not_read');
    expect(flag).toBeDefined();
    expect(flag!.sourceLines.length).toBeGreaterThan(0);
  });

  it('points at a line number a recruiter can open', () => {
    const quality = qualityOf(extractCvFacts(cv, { today: CORPUS_TODAY }));
    const flag = quality.flags.find((f) => f.code === 'dated_lines_not_read')!;
    expect(flag.message).toMatch(/line \d+/);
  });

  it('reports how much of the document it did read', () => {
    const quality = qualityOf(extractCvFacts(cv, { today: CORPUS_TODAY }));
    expect(quality.datedLines).toBeGreaterThan(quality.datedLinesRead);
  });
});

describe('a current role the reading could not find', () => {
  const cv = [
    'EXPERIENCE',
    'Senior Engineer, Northwind  Mar 2015 - Feb 2019',
    'Ran the payments platform.',
    'Principal Engineer, Halcyon  2019 - siden',
    'Owns the ledger.',
  ].join('\n');

  it('says so, because a line looks like a job that has not ended', () => {
    // "siden" is Danish for "since"; the vocabulary does not carry it. The
    // point is not that word — it is that the reading can tell the difference
    // between a CV with no current job and a CV whose current job it missed.
    expect(qualityOf(extractCvFacts(cv, { today: CORPUS_TODAY })).flags.map((f) => f.code))
      .toContain('no_current_role_read');
  });

  it('says it about the reading, never about the candidate', () => {
    const flag = qualityOf(extractCvFacts(cv, { today: CORPUS_TODAY }))
      .flags.find((f) => f.code === 'no_current_role_read')!;
    expect(flag.message).toMatch(/^We could not read a current role from this CV/);
    expect(flag.message).not.toMatch(/verify|unverified|claims?|suspicious|discrepan/i);
  });

  it('stays quiet when the candidate simply is not working', () => {
    // Every date read, nothing open-ended. A flag here would be an accusation
    // dressed as a parser note, and it would fire on every second CV.
    expect(codesFor('en-uk-dayfirst')).toEqual([]);
  });
});

describe('no flag anywhere reads as a judgement about the candidate', () => {
  it('never uses the vocabulary of doubt', () => {
    const offending: string[] = [];
    for (const fixture of CV_CORPUS) {
      for (const flag of qualityOf(extractCvFacts(corpusText(fixture), { today: CORPUS_TODAY })).flags) {
        if (/\b(verify|verified|unverified|claims?|claimed|suspicious|dishonest|discrepanc|inconsisten|misleading)\b/i.test(flag.message)) {
          offending.push(`${fixture.id}/${flag.code}: ${flag.message}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it('always names something to check', () => {
    for (const fixture of CV_CORPUS) {
      for (const flag of qualityOf(extractCvFacts(corpusText(fixture), { today: CORPUS_TODAY })).flags) {
        expect(flag.message, `${fixture.id}/${flag.code}`).toMatch(/check|open it|confirm/i);
      }
    }
  });
});
