import { execFileSync } from 'node:child_process';

let cached: string | null = null;

/**
 * The commit this process was built from, for operators. Read once and kept:
 * shelling out to git on every request would be a needless cost and a needless
 * failure mode, and an endpoint that fails because it could not identify itself
 * is worse than one that admits it does not know.
 *
 * Served on the public health check, which the deploy script reads to confirm
 * a release landed, and to admins under /api/admin/providers.
 */
export function resolveCommit(): string {
  if (cached) return cached;
  if (process.env.GIT_COMMIT) {
    cached = process.env.GIT_COMMIT.slice(0, 40);
    return cached;
  }
  try {
    cached = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    cached = 'unknown';
  }
  return cached;
}
