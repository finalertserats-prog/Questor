import { describe, expect, it } from 'vitest';
import { mentionsTechnology, mentionsTechnologyInProse, technologyPattern } from '../src/domain/techStack.js';
import { extractCvFacts } from '../src/engines/cvFacts.js';
import { CORPUS_TODAY, CV_CORPUS, corpusText } from './fixtures/cv/corpus.js';

/**
 * A technology the CV does not name.
 *
 * The observed failure: a German CV reading "- Verantwortlich für
 * Datenqualität und Monitoring" was credited with R, the programming
 * language. Not because of a substring — the matcher already asserts word
 * boundaries — but because it asserted them with `\w`, which is ASCII. `ü` is
 * not a `\w` character, so the "r" of "für" was a whole word with nothing on
 * either side of it.
 *
 * That is a class, not an instance. Every letter outside a-z read as a word
 * boundary, in every language a CV arrives in, next to every short technology
 * name in the catalogue. And single letters had a second hole: the job-
 * description reader has required "R" to sit in a list since it was written,
 * and the CV reader never did — so the invention landed on the candidate
 * rather than on the employer's own advert.
 *
 * An invented skill is not a cosmetic defect. It is shown to the hiring team
 * beside the person's name and it reaches the interviewer's prompt, so a
 * construction manager gets asked about a language he has never opened.
 */

describe('a letter with an accent beside it', () => {
  it('does not make a lone R out of the German word "für"', () => {
    expect(mentionsTechnology('für', 'R')).toBe(false);
  });

  it('does not make one out of a whole German bullet either', () => {
    expect(mentionsTechnology('- Verantwortlich für Datenqualität und Monitoring', 'R')).toBe(false);
  });

  it('treats every letter as a letter, not only the ASCII ones', () => {
    for (const [text, name] of [
      ['Betrieb von Kafka für Echtzeitdaten', 'R'],
      ['Gestión de la calidad', 'C'],
      ['Programação e análise', 'C'],
      ['Sprachkenntnisse: Deutsch, Englisch', 'C'],
    ] as const) {
      expect(mentionsTechnology(text, name), `${name} in ${text}`).toBe(false);
    }
  });

  it('still finds the technology when it is genuinely there, accents and all', () => {
    expect(mentionsTechnology('Conception de pipelines en Python et Airflow', 'Python')).toBe(true);
    expect(mentionsTechnology('Betrieb von Kafka für Echtzeitdaten', 'Kafka')).toBe(true);
  });

  it('holds when the accent arrives decomposed', () => {
    // A PDF text layer may hand us "fu" + U+0308 rather than "ü". Same word,
    // same document, and the combining mark is not a letter — so without
    // `\p{M}` in the boundary the "r" is standalone again and the bug returns
    // invisibly, because the two spellings look identical on screen.
    expect(mentionsTechnology('Verantwortlich für Datenqualität', 'R')).toBe(false);
    expect(mentionsTechnology('Gestión de la calidad', 'C')).toBe(false);
  });

  it('keeps the boundaries it already had', () => {
    expect(mentionsTechnology('A reactive system', 'React')).toBe(false);
    expect(mentionsTechnology('We use Google Cloud', 'Go')).toBe(false);
    expect(mentionsTechnology('Written in C++', 'C')).toBe(false);
    expect(mentionsTechnology('Services in C# and .NET', 'C#')).toBe(true);
    expect(technologyPattern('Go').flags).toContain('u');
  });
});

describe('a single letter in prose', () => {
  it('is not a language just because it stands alone', () => {
    expect(mentionsTechnologyInProse('Reported to R. Mehta, Head of Data', 'R')).toBe(false);
    expect(mentionsTechnologyInProse('Graded C in Mathematics', 'C')).toBe(false);
  });

  it('is a language when the CV lists it as one', () => {
    expect(mentionsTechnologyInProse('Languages: Python, R, SQL', 'R')).toBe(true);
    expect(mentionsTechnologyInProse('Statistical modelling in R and Python', 'R')).toBe(true);
  });

  it('is a language when the CV says so in a sentence', () => {
    // Most CVs outside engineering describe their work in prose. A list-only
    // rule loses the skill entirely, which lands on the same candidate as the
    // false positive did, from the other direction.
    expect(mentionsTechnologyInProse('Built the risk models using R.', 'R')).toBe(true);
    expect(mentionsTechnologyInProse('Firmware written in C.', 'C')).toBe(true);
    expect(mentionsTechnologyInProse('Hands-on experience with R', 'R')).toBe(true);
  });

  it('leaves names longer than a letter alone', () => {
    expect(mentionsTechnologyInProse('Rebuilt the billing service in Go', 'Go')).toBe(true);
  });
});

describe('across the corpus', () => {
  it('invents no technology on any fixture', () => {
    const invented: string[] = [];
    for (const fixture of CV_CORPUS) {
      const facts = extractCvFacts(corpusText(fixture), { today: CORPUS_TODAY });
      const found = new Set(facts.technologies.map((t) => t.name.toLowerCase()));
      for (const absent of fixture.notTechnologies) {
        if (found.has(absent.toLowerCase())) invented.push(`${fixture.id}: ${absent}`);
      }
    }
    expect(invented).toEqual([]);
  });

  it('still reads every technology the documents do name', () => {
    const missed: string[] = [];
    for (const fixture of CV_CORPUS) {
      const facts = extractCvFacts(corpusText(fixture), { today: CORPUS_TODAY });
      const found = new Set(facts.technologies.map((t) => t.name.toLowerCase()));
      for (const wanted of fixture.technologies) {
        if (!found.has(wanted.toLowerCase())) missed.push(`${fixture.id}: ${wanted}`);
      }
    }
    expect(missed).toEqual([]);
  });
});
