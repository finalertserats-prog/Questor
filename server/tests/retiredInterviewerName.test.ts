import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The single hardcoded interviewer name was replaced by the five selectable
// interviewers. Nothing in the server or web source may bring it back.

const RETIRED = ['Schr', 'anders'].join('');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_TREES = [join(repoRoot, 'server', 'src'), join(repoRoot, 'web', 'src')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css|html|json)$/.test(entry) ? [path] : [];
  });
}

describe('retired interviewer name', () => {
  it('appears nowhere in server/src or web/src', () => {
    const hits = SOURCE_TREES.flatMap(sourceFiles)
      .filter((file) => readFileSync(file, 'utf8').includes(RETIRED))
      .map((file) => relative(repoRoot, file));
    expect(hits).toEqual([]);
  });
});
