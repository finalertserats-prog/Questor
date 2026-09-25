import { canonicalByKey, extractableCompetencies } from '../../src/domain/taxonomy/index.js';
const line = 'Present findings to senior stakeholders and translate them into recommendations.';
const c = canonicalByKey('stakeholder & influence');
console.log('found entry:', !!c);
c?.cues.forEach((re, i) => console.log(i, re.source, '=>', re.test(line)));
console.log('in extractable:', extractableCompetencies().some((e) => e.key === 'stakeholder & influence'));
console.log('any extractable matching:', extractableCompetencies().filter((e) => e.cues.some((r) => r.test(line))).map((e) => e.name));
