// Rules behind the erase control on a candidate's page. Erasure is admin-only
// and irreversible; a person may have applied to several roles, and the admin
// chooses whether their other applications go too. Anything under legal hold
// stays, and the outcome says so.

export interface EraseResponse {
  /** Whether this application is gone. */
  readonly erased: boolean;
  /** Present when every application was asked for. */
  readonly erasedCount?: number;
  readonly skippedCount?: number;
  /** Applications an error stopped; this one is then kept so the request can be repeated. */
  readonly failedCount?: number;
}

export interface EraseOutcome {
  /** This page's candidate no longer exists. */
  readonly gone: boolean;
  readonly text: string;
}

const applications = (n: number): string => `${n} application${n === 1 ? '' : 's'}`;

export function eraseOthersLabel(otherCount: number): string {
  return `Also erase their ${otherCount} other application${otherCount === 1 ? '' : 's'}`;
}

export function eraseRequestBody(reason: string, allApplications: boolean): { reason: string; allApplications?: true } {
  return allApplications ? { reason: reason.trim(), allApplications: true } : { reason: reason.trim() };
}

export function eraseOutcome(res: EraseResponse): EraseOutcome {
  if (res.erasedCount === undefined) return { gone: res.erased, text: res.erased ? 'Candidate erased.' : 'Candidate not erased.' };
  const skipped = res.skippedCount ?? 0;
  const erased = `Erased ${applications(res.erasedCount)}.`;
  const failed = res.failedCount ?? 0;
  if (failed > 0) {
    const held = skipped > 0 ? ` ${applications(skipped)} under legal hold ${skipped === 1 ? 'was' : 'were'} kept.` : '';
    return { gone: res.erased, text: `${erased}${held} ${applications(failed)} could not be erased, so this one was kept. Erase again to finish.` };
  }
  if (skipped === 0) return { gone: res.erased, text: erased };
  const held = `${applications(skipped)} ${skipped === 1 ? 'is' : 'are'} under legal hold and ${skipped === 1 ? 'was' : 'were'} kept`;
  return { gone: res.erased, text: `${erased} ${held}${res.erased ? '.' : ', including this one.'}` };
}
