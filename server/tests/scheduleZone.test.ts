import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { candidateOwnZone, isNamedTimeZone, orgZone, timeZoneField } from '../src/services/scheduleZone.js';
import { formatScheduledTime } from '../src/services/zonedTime.js';

/**
 * A zone on a screen is one of four facts, and they are not interchangeable:
 * the zone a round was booked in, the zone the candidate was in when it was,
 * the zone the organisation chose, and IST because nobody chose anything.
 *
 * The bug this closes is not that the wrong one gets used — the fallback order
 * is fine — it is that the substitution was silent. A Bengaluru organisation
 * could not tell the difference; everybody else was reading a made-up clock
 * that was labelled as confidently as a real one.
 */

let tenantId = '';
let candidateId = '';

beforeEach(async () => {
  await wipe();
  const demo = await createDemoData();
  tenantId = demo.tenantId;
  candidateId = demo.candidateId;
});

async function setOrgZone(timeZone: string | null) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const policy = { ...JSON.parse(tenant.policyJson) as Record<string, unknown> };
  if (timeZone === null) delete policy.timeZone;
  else policy.timeZone = timeZone;
  await prisma.tenant.update({ where: { id: tenantId }, data: { policyJson: JSON.stringify(policy) } });
}

describe('a time zone from a client', () => {
  it('accepts a real IANA zone', () => {
    expect(timeZoneField.parse(' Europe/Berlin ')).toBe('Europe/Berlin');
  });

  it('refuses a zone the runtime does not know', () => {
    expect(timeZoneField.safeParse('Mars/Olympus_Mons').success).toBe(false);
  });

  it('refuses an offset pretending to be a zone', () => {
    expect(timeZoneField.safeParse('+05:30').success).toBe(false);
  });
});

/**
 * Tightening the check guards what is written from now on. It does not reach
 * a row that already holds an offset, and no migration cleans them — so the
 * question that matters is whether such a row still reads.
 *
 * It does, and that is deliberate: the read path stays permissive. A round
 * booked long ago under "+05:30" renders at the right offset, just with no
 * daylight-saving rules behind it, which is the wrong-by-an-hour-in-summer
 * case the write check now prevents from ever being created again. Refusing to
 * render it would turn a subtly wrong time into a blank one.
 */
describe('a zone stored before the check was tightened', () => {
  const at = new Date('2026-10-01T09:00:00.000Z');

  it('is no longer writable', () => {
    expect(isNamedTimeZone('+05:30')).toBe(false);
  });

  it('still renders, rather than a row becoming unreadable', () => {
    expect(formatScheduledTime(at, '+05:30')).toContain('14:30');
  });

  it('still names what it was stored as, so nobody mistakes it for a real zone', () => {
    expect(formatScheduledTime(at, '+05:30')).toContain('+05:30');
  });
});

describe('the organisation zone', () => {
  it('reports a zone the organisation chose as chosen', async () => {
    await setOrgZone('America/New_York');

    expect(await orgZone(tenantId)).toEqual({ zone: 'America/New_York', source: 'org' });
  });

  it('marks IST as assumed when the organisation chose nothing', async () => {
    await setOrgZone(null);

    expect(await orgZone(tenantId)).toEqual({ zone: 'Asia/Kolkata', source: 'org_default' });
  });

  it('marks IST as assumed when the stored zone is one the runtime does not know', async () => {
    await setOrgZone('Mars/Olympus_Mons');

    expect(await orgZone(tenantId)).toEqual({ zone: 'Asia/Kolkata', source: 'org_default' });
  });
});

describe('the zone a new booking for a candidate defaults to', () => {
  it('is the zone HR set for them', async () => {
    await prisma.candidate.update({ where: { id: candidateId }, data: { timeZone: 'Europe/Berlin' } });

    expect(await candidateOwnZone(tenantId, candidateId)).toBe('Europe/Berlin');
  });

  it('is nothing at all when HR has not set one, rather than the organisation\u2019s', async () => {
    await setOrgZone('America/New_York');

    expect(await candidateOwnZone(tenantId, candidateId)).toBeNull();
  });

  it('ignores a stored zone this runtime cannot use', async () => {
    await prisma.candidate.update({ where: { id: candidateId }, data: { timeZone: 'Mars/Olympus_Mons' } });

    expect(await candidateOwnZone(tenantId, candidateId)).toBeNull();
  });

  it('never reaches a candidate in another organisation', async () => {
    await prisma.candidate.update({ where: { id: candidateId }, data: { timeZone: 'Europe/Berlin' } });

    expect(await candidateOwnZone('some-other-tenant', candidateId)).toBeNull();
  });
});
