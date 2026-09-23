import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Encryption at rest for the candidate content in `Artifact.storageKey`, end to
 * end: what a new write puts in the column, what a backup would show, what the
 * backfill does to rows written before the switch, and that erasure, the
 * retention sweep and the transcript reader are untouched by any of it.
 */

const KEY = randomBytes(32).toString('base64');
const NEW_KEY = randomBytes(32).toString('base64');

/** The switch and the keys, changed per test the way a deployment would. */
const settings = vi.hoisted(() => ({ enabled: false, key: '', previousKeys: '' }));

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      get artifactEncryption() {
        return { enabled: settings.enabled, key: settings.key, previousKeys: settings.previousKeys };
      },
    },
  };
});

const { prisma } = await import('../src/db.js');
const { createDemoData, wipe } = await import('../src/seed/demoData.js');
const { _resetArtifactKeyring, readArtifactContent, storedArtifactContent } = await import('../src/services/artifactContent.js');
const { backfillArtifactEncryption } = await import('../src/services/artifactBackfill.js');
const { isSealedArtifact } = await import('../src/services/artifactSeal.js');
const { eraseCandidate, purgeExpiredArtifacts } = await import('../src/services/dataRights.js');
const { collectIssues } = await import('../src/preflight.js');

const CV = 'Ananya Iyer — Data Engineer. Rebuilt the billing pipeline in Spark; cut the nightly run to forty minutes.';
const TRANSCRIPT = '[00:00] AI: Tell me about the billing pipeline.\n[00:12] CANDIDATE: I rewrote it in Spark.';

function use(over: Partial<typeof settings> = {}): void {
  Object.assign(settings, { enabled: false, key: '', previousKeys: '', ...over });
  _resetArtifactKeyring();
}

async function artifact(ids: Awaited<ReturnType<typeof createDemoData>>, content: string, kind = 'transcript') {
  return prisma.artifact.create({
    data: {
      tenantId: ids.tenantId, candidateId: ids.candidateId, sessionId: kind === 'resume' ? null : ids.sessionId,
      kind, filename: 'f.txt', contentType: 'text/plain',
      storageKey: storedArtifactContent(content), sizeBytes: content.length, retentionDays: 180,
    },
  });
}

const stored = async (id: string) => (await prisma.artifact.findUniqueOrThrow({ where: { id }, select: { storageKey: true } })).storageKey;

beforeEach(async () => {
  await wipe();
  use();
});

afterEach(() => {
  use();
});

describe('a new write while encryption is on', () => {
  it('leaves none of the candidate’s words in the column', async () => {
    use({ enabled: true, key: KEY });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    expect(await stored(row.id)).not.toContain('billing');
  });

  it('gives the content back to the application unchanged', async () => {
    use({ enabled: true, key: KEY });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    expect(readArtifactContent(await stored(row.id))).toBe(TRANSCRIPT);
  });

  it('records the size of the content, not of the envelope around it', async () => {
    use({ enabled: true, key: KEY });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    const saved = await prisma.artifact.findUniqueOrThrow({ where: { id: row.id }, select: { sizeBytes: true, storageKey: true } });
    expect({ size: saved.sizeBytes, longer: saved.storageKey.length > TRANSCRIPT.length }).toEqual({ size: TRANSCRIPT.length, longer: true });
  });
});

describe('the switch', () => {
  it('writes clear text while it is off, so the release is safe to take', async () => {
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    expect(await stored(row.id)).toBe(TRANSCRIPT);
  });

  it('writes clear text when it is on but no key was set, rather than pretending', async () => {
    use({ enabled: true, key: '' });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    expect(await stored(row.id)).toBe(TRANSCRIPT);
  });

  it('writes clear text when a key is set but the switch is still off — the state during the backfill', async () => {
    use({ enabled: false, key: KEY });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    expect(await stored(row.id)).toBe(TRANSCRIPT);
  });

  it('still reads rows written before it was switched on', async () => {
    const ids = await createDemoData();
    const row = await artifact(ids, CV, 'resume');
    use({ enabled: true, key: KEY });
    expect(readArtifactContent(await stored(row.id))).toBe(CV);
  });
});

/** The owner's order: set the key, run the backfill, then turn the switch on. */
describe('the backfill', () => {
  async function threeClearRows() {
    const ids = await createDemoData();
    const rows = [await artifact(ids, CV, 'resume'), await artifact(ids, TRANSCRIPT), await artifact(ids, 'A third.')];
    return { ids, rows };
  }

  it('seals every row written before the switch', async () => {
    const { rows } = await threeClearRows();
    use({ key: KEY });
    const progress = await backfillArtifactEncryption({ batchSize: 2 });
    expect({ sealed: progress.sealed, done: progress.done }).toEqual({ sealed: 3, done: true });
    expect((await Promise.all(rows.map((r) => stored(r.id)))).every(isSealedArtifact)).toBe(true);
  });

  it('keeps the content readable afterwards', async () => {
    const { rows } = await threeClearRows();
    use({ key: KEY });
    await backfillArtifactEncryption();
    expect(readArtifactContent(await stored(rows[1].id))).toBe(TRANSCRIPT);
  });

  it('changes nothing on a second run', async () => {
    await threeClearRows();
    use({ key: KEY });
    await backfillArtifactEncryption();
    const again = await backfillArtifactEncryption();
    expect({ sealed: again.sealed, already: again.alreadySealed }).toEqual({ sealed: 0, already: 3 });
  });

  it('stops at the limit and says where to resume from', async () => {
    await threeClearRows();
    use({ key: KEY });
    const first = await backfillArtifactEncryption({ maxRows: 2 });
    expect({ scanned: first.scanned, done: first.done }).toEqual({ scanned: 2, done: false });
    const rest = await backfillArtifactEncryption({ after: first.lastId });
    expect({ sealed: rest.sealed, done: rest.done }).toEqual({ sealed: 1, done: true });
  });

  it('seals everything even when resumed from the start instead', async () => {
    await threeClearRows();
    use({ key: KEY });
    await backfillArtifactEncryption({ maxRows: 2 });
    const rerun = await backfillArtifactEncryption();
    expect({ sealed: rerun.sealed, already: rerun.alreadySealed }).toEqual({ sealed: 1, already: 2 });
  });

  it('writes nothing on a dry run', async () => {
    const { rows } = await threeClearRows();
    use({ key: KEY });
    const progress = await backfillArtifactEncryption({ dryRun: true });
    expect({ would: progress.sealed, stored: await stored(rows[0].id) }).toEqual({ would: 3, stored: CV });
  });

  it('refuses when there is no key to seal under', async () => {
    await threeClearRows();
    await expect(backfillArtifactEncryption()).rejects.toThrow('ARTIFACT_ENCRYPTION_KEY');
  });

  it('re-seals a row under the new key when the old one is being retired', async () => {
    use({ enabled: true, key: KEY });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    use({ enabled: true, key: NEW_KEY, previousKeys: KEY });
    const progress = await backfillArtifactEncryption();
    expect({ rotated: progress.rotated, sealed: progress.sealed }).toEqual({ rotated: 1, sealed: 0 });
    expect(readArtifactContent(await stored(row.id))).toBe(TRANSCRIPT);
  });

  it('leaves a row it cannot open exactly as it is, and counts it', async () => {
    use({ enabled: true, key: NEW_KEY });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    const before = await stored(row.id);
    use({ key: KEY });
    const progress = await backfillArtifactEncryption();
    expect({ unreadable: progress.unreadable, unchanged: await stored(row.id) === before }).toEqual({ unreadable: 1, unchanged: true });
  });
});

/**
 * Encryption must not cost the candidate any of their rights. These paths only
 * ever delete artifacts or count them, so they work on ciphertext untouched —
 * proved rather than assumed.
 */
describe('the candidate’s rights, with encryption on', () => {
  it('erases a candidate’s artifacts', async () => {
    use({ enabled: true, key: KEY });
    const ids = await createDemoData();
    await artifact(ids, CV, 'resume');
    await eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'Candidate asked for erasure.' });
    expect(await prisma.artifact.count({ where: { candidateId: ids.candidateId } })).toBe(0);
  });

  it('sweeps an artifact past its retention window', async () => {
    use({ enabled: true, key: KEY });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    await prisma.artifact.update({ where: { id: row.id }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
    await purgeExpiredArtifacts(new Date());
    expect(await prisma.artifact.count({ where: { id: row.id } })).toBe(0);
  });

  it('keeps the transcript readable through the reader the recruiter uses', async () => {
    use({ enabled: true, key: KEY });
    const ids = await createDemoData();
    const row = await artifact(ids, TRANSCRIPT);
    expect(readArtifactContent(await stored(row.id))).toContain('billing pipeline');
  });

  it('leaves the Turn rows the transcript reader serves in clear text', async () => {
    use({ enabled: true, key: KEY });
    const ids = await createDemoData();
    await artifact(ids, TRANSCRIPT);
    const turn = await prisma.turn.findFirst({ where: { sessionId: ids.sessionId }, orderBy: { index: 'asc' } });
    expect(isSealedArtifact(turn?.text ?? '')).toBe(false);
  });
});

/**
 * The dangerous combination is the switch on with no key: nothing is sealed
 * while the operator who set the flag believes everything is. Production
 * refuses to start; development says so loudly and carries on, so the
 * zero-setup demo still works (preflight.ts).
 */
describe('what preflight says at boot', () => {
  const codes = () => collectIssues({}).map((i) => i.code);
  const issue = (code: string) => collectIssues({}).find((i) => i.code === code);

  it('complains when the switch is on with no key', () => {
    use({ enabled: true, key: '' });
    expect(codes()).toContain('ARTIFACT_ENCRYPTION_KEY_MISSING');
  });

  it('says plainly that candidate content is still in clear text', () => {
    use({ enabled: true, key: '' });
    expect(issue('ARTIFACT_ENCRYPTION_KEY_MISSING')?.message).toMatch(/clear text/);
  });

  it('tells the operator how to generate a key', () => {
    use({ enabled: true, key: '' });
    expect(issue('ARTIFACT_ENCRYPTION_KEY_MISSING')?.fix).toMatch(/openssl rand/);
  });

  it('complains about a key of the wrong length', () => {
    use({ enabled: true, key: 'dGhpcyBpcyBub3QgMzIgYnl0ZXM=' });
    expect(codes()).toContain('ARTIFACT_ENCRYPTION_KEY_MALFORMED');
  });

  it('never puts the key material in the message', () => {
    use({ enabled: true, key: 'dGhpcyBpcyBub3QgMzIgYnl0ZXM=' });
    expect(issue('ARTIFACT_ENCRYPTION_KEY_MALFORMED')?.message).not.toContain('dGhpcyBpcyBub3Q');
  });

  it('complains about a malformed retired key too', () => {
    use({ enabled: true, key: KEY, previousKeys: 'not-a-key' });
    expect(codes()).toContain('ARTIFACT_ENCRYPTION_KEY_MALFORMED');
  });

  it('says nothing about a key set while the switch is still off — the state during the backfill', () => {
    use({ enabled: false, key: KEY });
    expect(codes().filter((c) => c.startsWith('ARTIFACT_ENCRYPTION'))).toEqual([]);
  });

  it('says nothing when both are unset', () => {
    use();
    expect(codes().filter((c) => c.startsWith('ARTIFACT_ENCRYPTION'))).toEqual([]);
  });

  it('says nothing once the key and the switch agree', () => {
    use({ enabled: true, key: KEY });
    expect(codes().filter((c) => c.startsWith('ARTIFACT_ENCRYPTION'))).toEqual([]);
  });
});
