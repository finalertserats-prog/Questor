/**
 * Fetching from the public sources the catalog refresh reads. Each request is
 * bounded by a timeout, and a server error or network failure is retried with
 * a growing pause: a monthly job should survive a flaky minute at the
 * source, and must not hang the run on a request that never answers.
 */

export interface SourceHttp {
  readonly fetch: typeof fetch;
  /** Injected so tests do not wait out real backoff or politeness delays. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeoutMs: number;
}

export class SourceFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

const DEFAULT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;

function retryable(status: number): boolean {
  return status >= 500 || status === 429;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'the source'; }
}

export async function fetchWithRetry(
  url: string,
  http: SourceHttp,
  opts: { readonly init?: RequestInit; readonly attempts?: number; readonly timeoutMs?: number } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  let lastProblem = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await http.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 2));
    try {
      const response = await http.fetch(url, { ...opts.init, signal: AbortSignal.timeout(opts.timeoutMs ?? http.timeoutMs) });
      if (response.ok) return response;
      lastProblem = `HTTP ${response.status}`;
      if (!retryable(response.status)) throw new SourceFetchError(`${hostOf(url)} answered ${lastProblem}`, response.status);
    } catch (err) {
      if (err instanceof SourceFetchError) throw err;
      lastProblem = err instanceof Error ? err.message : String(err);
    }
  }
  throw new SourceFetchError(`${hostOf(url)} failed after ${attempts} attempts: ${lastProblem}`);
}
