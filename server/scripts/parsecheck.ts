import { readFileSync } from 'node:fs';
import { extractResumeText, extractJdText, normalizeProfile } from '../src/engines/resumeParser.js';

for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const isJd = /JD /i.test(f);
  const text = isJd ? await extractJdText(buf, 'application/pdf') : await extractResumeText(buf, 'application/pdf');
  console.log('='.repeat(72));
  console.log(f.split(/[\/]/).pop(), '| chars:', text.length);
  if (isJd) { console.log(text.slice(0, 3000)); continue; }
  const p = normalizeProfile(text);
  console.log('totalYears:', p.totalYears);
  console.log('skills:', JSON.stringify(p.skills));
  console.log('certifications:', JSON.stringify(p.certifications));
  console.log('employment:', JSON.stringify(p.employment, null, 1));
  console.log('education:', JSON.stringify(p.education));
  console.log('YEARS SEEN:', JSON.stringify(text.match(/(19|20)\d{2}/g)));
}
