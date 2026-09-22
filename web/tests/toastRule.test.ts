import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Done, nothing more to do" is a toast; a banner is for what still waits on
 * someone. A success banner fed from a transient notice (setNotice('Saved.'))
 * is the pattern the shared toast replaced, so it must not come back.
 */

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

// Pages another piece of work is redesigning; they convert with that work.
const REDESIGNED_ELSEWHERE = ['Dashboard.tsx', 'InterviewRoom.tsx', 'Portal.tsx', 'About.tsx', 'Login.tsx'];

describe('success confirmations', () => {
  it('are not shown as success banners fed from a transient notice', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !REDESIGNED_ELSEWHERE.some((name) => file.endsWith(name)))
      .filter((file) => /<Banner kind="ok">\{\w*[nN]otice\}<\/Banner>/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('are not chosen between ok and error on one banner', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !REDESIGNED_ELSEWHERE.some((name) => file.endsWith(name)))
      .filter((file) => /<Banner kind=\{\w+\.ok \? 'ok' : 'error'\}>/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
