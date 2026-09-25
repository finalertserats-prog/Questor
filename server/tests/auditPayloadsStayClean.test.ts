import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { carriesContactDetail } from '../src/services/calibrationAggregate.js';

/**
 * The audit rows anonymisation and erasure deliberately DO NOT clear.
 *
 * `CandidateImportBatch`, `CalibrationAdjustment` and `CalibrationAnchorProposal`
 * are not per-candidate rows. Each covers many people at once, so clearing one
 * to remove a single person would destroy a record belonging to everybody else
 * in it — which is neither what erasure asks for nor what a timer expiring
 * justifies. Leaving them alone is only defensible while they carry nothing
 * about an individual, so that property has to be held in place rather than
 * believed.
 *
 * These tests are the holding. They do not test the sweep; they test the
 * premise the sweep's exclusion rests on.
 */

const app = createApp();

describe('what a bulk import writes to the audit log', () => {
  beforeEach(async () => { await wipe(); });

  it('records the role and nothing else, so no candidate is in a batch-wide row', async () => {
    // Safe by construction today — the names and the per-row failure messages
    // go to the HTTP response, never to a payload. This pins it, because the
    // next person to add a field here would silently make a shared row
    // impossible to clean up without harming everyone else in the import.
    const ids = await createDemoData();
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });

    const started = await request(app).post('/api/candidate-imports')
      .set('Authorization', `Bearer ${login.body.token as string}`)
      .send({ roleId: ids.roleId });
    expect(started.status).toBe(201);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'candidate_import.started' } });
    expect(Object.keys(JSON.parse(event.afterJson) as Record<string, unknown>)).toEqual(['roleId']);
  });
});

/**
 * A calibration theme becomes an anchor and an audit payload on a
 * cross-candidate row, which nothing can clean up afterwards. The prompt
 * already forbids repeating an address; this is the check that makes it more
 * than a request.
 */
describe('a calibration theme may not carry a contact detail', () => {
  it.each([
    'candidates who email priya.sharma@example.com directly',
    'reachable on 9876543210 for follow-up',
    'call +91 98765 43210 to confirm',
  ])('rejects %j', (label) => {
    expect(carriesContactDetail(label)).toBe(true);
  });

  it.each([
    'explains trade-offs before choosing an approach',
    'cut p99 latency from 1200ms to 180ms',
    'handles http 500 responses with a retry budget',
    'names the failure mode before the fix',
  ])('leaves ordinary engineering vocabulary alone: %j', (label) => {
    // Over-rejecting here is not free: a theme thrown away is calibration the
    // organisation does not get, so the check has to be narrow enough that
    // numbers in an engineering phrase survive it.
    expect(carriesContactDetail(label)).toBe(false);
  });
});
