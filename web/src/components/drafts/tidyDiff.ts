/**
 * The before-and-after for "tidy up what I wrote".
 *
 * A tidied version is shown next to the original with every change marked,
 * because the person is being asked to approve a rewrite of their own words
 * and cannot do that from a block of new prose. What changed is marked by a
 * sign (− / +), a rule and weight rather than by a coloured fill, so the marks
 * survive being printed, being read in high contrast, and being read aloud.
 *
 * Word-level, longest-common-subsequence. It is a reading aid, not a merge
 * tool: a tidy of a few sentences is small enough for the quadratic table, and
 * anything longer falls back to "the whole thing changed", which is honest.
 */

export type DiffKind = 'same' | 'removed' | 'added';

export interface DiffSegment {
  readonly kind: DiffKind;
  readonly text: string;
}

/** Above this many words the table is not worth building; the panel says so instead. */
export const MAX_DIFF_WORDS = 600;

function words(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part !== '');
}

function join(parts: readonly string[]): string {
  return parts.join('');
}

/**
 * `before` with removals marked, and `after` with additions marked. Two lists
 * rather than one interleaved list: the panel shows the two versions side by
 * side, and a reader compares them whole.
 */
export interface TidyDiff {
  readonly before: readonly DiffSegment[];
  readonly after: readonly DiffSegment[];
  /** False when the texts were too long to compare word by word. */
  readonly detailed: boolean;
  /** True when the tidy changed nothing at all. */
  readonly unchanged: boolean;
}

export function tidyDiff(before: string, after: string): TidyDiff {
  if (before === after) {
    return { before: [{ kind: 'same', text: before }], after: [{ kind: 'same', text: after }], detailed: true, unchanged: true };
  }
  const a = words(before);
  const b = words(after);
  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) {
    return {
      before: [{ kind: 'removed', text: before }],
      after: [{ kind: 'added', text: after }],
      detailed: false,
      unchanged: false,
    };
  }

  // table[i][j] = length of the longest common subsequence of a[i:] and b[j:]
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const beforeOut: DiffSegment[] = [];
  const afterOut: DiffSegment[] = [];
  const push = (into: DiffSegment[], kind: DiffKind, text: string) => {
    const last = into[into.length - 1];
    if (last && last.kind === kind) into[into.length - 1] = { kind, text: last.text + text };
    else into.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(beforeOut, 'same', a[i]);
      push(afterOut, 'same', b[j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push(beforeOut, 'removed', a[i]);
      i += 1;
    } else {
      push(afterOut, 'added', b[j]);
      j += 1;
    }
  }
  if (i < a.length) push(beforeOut, 'removed', join(a.slice(i)));
  if (j < b.length) push(afterOut, 'added', join(b.slice(j)));

  return { before: beforeOut, after: afterOut, detailed: true, unchanged: false };
}
