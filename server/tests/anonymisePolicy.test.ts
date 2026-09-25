import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_ANONYMISE_AFTER_DAYS,
  anonymiseAfterDays,
  anonymisationEnabled,
  anonymisationSweepRunNote,
  retentionPostureMessage,
  startAnonymisationSweep,
  type AnonymiseResult,
} from '../src/services/anonymise.js';
import { logger } from '../src/logger.js';

/**
 * The settings that decide whether anything is anonymised at all, and what the
 * server says about them.
 *
 * Anonymisation is irreversible, so every one of these is a guard rather than a
 * convenience: a window that reads a number out of a typo, or a sweep that
 * starts because a deploy variable was absent, rewrites real customer data in a
 * way nothing short of a database restore can undo.
 */

const windowEnv = process.env.ANONYMISE_AFTER_DAYS;
const enabledEnv = process.env.ANONYMISE_SWEEP_ENABLED;

afterEach(() => {
  if (windowEnv === undefined) delete process.env.ANONYMISE_AFTER_DAYS;
  else process.env.ANONYMISE_AFTER_DAYS = windowEnv;
  if (enabledEnv === undefined) delete process.env.ANONYMISE_SWEEP_ENABLED;
  else process.env.ANONYMISE_SWEEP_ENABLED = enabledEnv;
  vi.restoreAllMocks();
});

const withWindow = (value: string | undefined) => {
  if (value === undefined) delete process.env.ANONYMISE_AFTER_DAYS;
  else process.env.ANONYMISE_AFTER_DAYS = value;
  return anonymiseAfterDays();
};

describe('the anonymisation window setting', () => {
  it('is twelve months when nothing is configured', () => {
    expect(withWindow(undefined)).toBe(DEFAULT_ANONYMISE_AFTER_DAYS);
  });

  it('takes a whole number of days', () => {
    expect(withWindow('540')).toBe(540);
  });

  it.each(['12m', '1y', '365d', '2 years', '30.5', '', 'never'])('keeps the default rather than reading a number out of %j', (value) => {
    expect(withWindow(value)).toBe(DEFAULT_ANONYMISE_AFTER_DAYS);
  });

  it('keeps the default for zero and negative days, which would sever every candidate at once', () => {
    expect([withWindow('0'), withWindow('-1')]).toEqual([DEFAULT_ANONYMISE_AFTER_DAYS, DEFAULT_ANONYMISE_AFTER_DAYS]);
  });

  it('says so in the log when it ignores a value, so nobody trusts a window that is not in force', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    withWindow('12m');

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('opting in', () => {
  it('is off unless the deployment says exactly "true"', () => {
    process.env.ANONYMISE_SWEEP_ENABLED = 'TRUE';
    expect(anonymisationEnabled()).toBe(false);
  });

  it('is off when the setting is absent, so deploying this code anonymises nothing', () => {
    delete process.env.ANONYMISE_SWEEP_ENABLED;
    expect(anonymisationEnabled()).toBe(false);
  });

  it('starts no job while it is off', () => {
    delete process.env.ANONYMISE_SWEEP_ENABLED;
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);

    const stop = startAnonymisationSweep(60_000);
    stop();

    // A sweep that ran once "just to see" would already have severed people.
    expect(info).not.toHaveBeenCalled();
  });
});

describe('the run note', () => {
  const result = (over: Partial<AnonymiseResult> = {}): AnonymiseResult => ({
    candidatesAnonymised: 3, skipped: 0, failed: 0, failures: [], changed: { turns: 42 }, ...over,
  });

  it('records what changed when every candidate was done', () => {
    expect(anonymisationSweepRunNote(result())).toBe('{"turns":42}');
  });

  it('throws when a candidate survived, so the run is recorded as failed and the operator hears about it', () => {
    // "Last succeeded" over data that is still named is the failure mode this
    // exists to prevent — the same reasoning as retentionSweepRunNote.
    expect(() => anonymisationSweepRunNote(result({ failed: 2, failures: ['cand_a', 'cand_b'] })))
      .toThrow(/2 candidates could not be anonymised \(cand_a, cand_b\)/);
  });
});

describe('what the server says about itself at boot', () => {
  it('warns when neither storage-limitation answer is switched on', () => {
    const posture = retentionPostureMessage({ sweepEnabled: false, anonymiseEnabled: false });
    expect(posture.level).toBe('warn');
    expect(posture.message).toMatch(/kept indefinitely with the candidate identified/);
  });

  it('stops warning once the deployment has chosen anonymisation, and describes that choice', () => {
    const posture = retentionPostureMessage({ sweepEnabled: false, anonymiseEnabled: true });
    expect(posture.level).toBe('info');
    expect(posture.message).toMatch(/Interviews are kept indefinitely/);
  });

  it('claims only that the details Questor holds are removed, never that a transcript is anonymous', () => {
    // The honest claim is the one the code can support. A transcript can still
    // name a former employer or a manager, and a message that said
    // "anonymised" full stop would be the product overstating what it does.
    const posture = retentionPostureMessage({ sweepEnabled: false, anonymiseEnabled: true });
    expect(posture.message).toMatch(/identifying details Questor holds/);
    expect(posture.message).toMatch(/Third parties a candidate mentions in passing cannot be found/);
  });

  it('says plainly when deletion is in force, since anonymisation then rarely gets a chance to run', () => {
    const posture = retentionPostureMessage({ sweepEnabled: true, anonymiseEnabled: true });
    expect(posture.message).toMatch(/anonymisation is normally an alternative to deletion/);
  });
});
