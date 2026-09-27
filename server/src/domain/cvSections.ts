import type { CvSection } from './cvFacts.js';

/**
 * What a CV calls its sections — one vocabulary, read by everything.
 *
 * There were two. `cvRedaction`'s patterns decided which section each line was
 * filed under, and `resumeParser`'s set decided which lines counted towards
 * years of experience, and they did not agree: the parser knew "relevant
 * experience", "positions held", "career" and "roles"; the redactor, which is
 * the one the scorer reads through, did not.
 *
 * A heading the redactor does not recognise leaves `section` as `summary` for
 * the whole document. `isRoleHeading` then returns false on every line, the CV
 * yields ZERO roles, every technology loses its dates and falls from 95 to 55,
 * and confidence is docked a further 0.15. The candidate is marked down for
 * the word they chose as a heading, and nothing anywhere says so.
 *
 * Non-English headings are here for the same reason and a blunter one: a CV is
 * written in the language its author works in, and "Berufserfahrung" is not a
 * defect in the candidate. Accents are matched optionally throughout, because
 * a PDF text layer drops them often enough that requiring them would reinstate
 * the bug for the CVs most likely to carry them.
 */

/** Written as alternations so both a whole-line set and a prefix test can use them. */
const EXPERIENCE = [
  // English, including every shape the resume parser already knew.
  '(?:work|professional|relevant|related|industry|career|employment)?\\s*experience',
  'experience\\s+summary',
  'employment(?:\\s+history)?',
  'work\\s+history',
  'career(?:\\s+(?:history|summary|timeline|experience))?',
  'professional\\s+(?:history|background)',
  'positions?\\s+held',
  'appointments',
  'roles(?:\\s+(?:held|and\\s+responsibilities))?',
  'my\\s+journey',
  // A bare "Work" heading. Safe beside `coursework` and `volunteer experience`
  // because the matchers are anchored at both ends and the back-of-CV list is
  // tested first, so neither can reach this alternative.
  'work',
  // German, French, Spanish, Portuguese, Italian, Dutch.
  'berufserfahrung',
  'berufliche\\s+erfahrung',
  'parcours\\s+professionnel',
  'exp[ée]rience(?:s)?(?:\\s+professionnelle(?:s)?)?',
  'experiencia(?:\\s+(?:profesional|laboral))?',
  'experi[êe]ncia(?:\\s+profissional)?',
  'esperienza(?:\\s+lavorativa)?',
  'werkervaring',
  'arbeidservaring',
];

const EDUCATION = [
  'education',
  'academic(?:\\s+(?:background|qualifications?|history))?',
  'qualifications?',
  'ausbildung',
  'studium',
  'bildung',
  'formation(?:\\s+acad[ée]mique)?',
  'formaci[óo]n(?:\\s+acad[ée]mica)?',
  'educaci[óo]n',
  'forma[çc][ãa]o(?:\\s+acad[êe]mica)?',
  'educa[çc][ãa]o',
  'istruzione',
  'formazione',
  'opleiding',
  'onderwijs',
];

const SKILLS = [
  'skills?',
  '(?:technical|core|key)\\s+skills?',
  'core\\s+competenc(?:y|ies)',
  'competenc(?:y|ies)',
  'areas?\\s+of\\s+expertise',
  'expertise',
  'technolog(?:y|ies)',
  'tech\\s+stack',
  'toolkit',
  'tools',
  'kenntnisse',
  'f[äa]higkeiten',
  'comp[ée]tences',
  'habilidades',
  'compet[êe]ncias',
  'vaardigheden',
];

const PROJECTS = ['projects?', '(?:selected|personal|key)\\s+projects?', 'portfolio', 'projekte', 'projets', 'proyectos', 'projetos', 'progetti'];

const CERTIFICATIONS = [
  'certifications?', 'certificates?', 'licen[cs]es?', 'accreditations?', 'training',
  'zertifikate', 'zertifizierungen', 'certifications?\\s+professionnelles?', 'certificaciones', 'certificazioni', 'certificaten',
];

const SUMMARY = [
  'summary', 'profile(?:\\s+summary)?', 'objective', 'about(?:\\s+me)?', 'professional\\s+summary',
  'profil', 'zusammenfassung', '[üu]ber\\s+mich', 'resumen', 'perfil', 'sommario', 'profiel',
];

/**
 * The back of the CV: neither work nor a claim about skills.
 *
 * Named because a heading this list does not recognise leaves every line under
 * it filed as whatever came before — and on an academic CV what comes before
 * is the experience section, so every entry in a forty-item bibliography read
 * as a job the person had done. The citations are full of the right words, so
 * the evidence count grew with the length of the bibliography.
 */
const OTHER = [
  'publications?', 'selected\\s+publications?', 'papers?', 'grants?', 'funding',
  'awards?', 'honou?rs', 'achievements', 'patents?', 'conferences?', 'talks?',
  'presentations?', 'references?', 'interests?', 'hobbies', 'activities',
  'memberships?', 'affiliations?', 'languages?', 'volunteering', 'volunteer\\s+experience',
  'courses?', 'coursework', 'key\\s+highlights', 'highlights',
  'ver[öo]ffentlichungen', 'auszeichnungen', 'sprachen',
  'publications?\\s+scientifiques', 'langues', 'centres?\\s+d.int[ée]r[êe]t',
  'idiomas', 'premios', 'pubblicazioni', 'talen',
];

/**
 * Order matters. `volunteer experience` has to be read as the back of the CV
 * before the experience list claims it, or unpaid work is counted as
 * employment — so the specific sections are tested before the general one.
 */
export const CV_SECTION_VOCABULARY: ReadonlyArray<{ readonly section: CvSection; readonly words: readonly string[] }> = [
  { section: 'other', words: OTHER },
  { section: 'education', words: EDUCATION },
  { section: 'certifications', words: CERTIFICATIONS },
  { section: 'projects', words: PROJECTS },
  { section: 'skills', words: SKILLS },
  { section: 'experience', words: EXPERIENCE },
  { section: 'summary', words: SUMMARY },
];

/**
 * A heading is a short line that names a section and nothing else.
 *
 * Anchored at both ends, with only a connector and one more heading word
 * allowed after it ("Education and Qualifications", "Skills / Tools"). Left
 * open-ended it matched "I have eight years of experience building data
 * platforms", which reset the section mid-career and filed the rest of the job
 * under a summary.
 */
export const CV_SECTION_MATCHERS: ReadonlyArray<{ readonly section: CvSection; readonly re: RegExp }> =
  CV_SECTION_VOCABULARY.map(({ section, words }) => ({
    section,
    re: new RegExp(`^(?:${words.join('|')})(?:\\s*(?:&|and|und|et|y|e|en|/|,|\\|)\\s*[a-zà-ÿ ]{2,30})?$`, 'i'),
  }));
