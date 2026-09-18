import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimHealth, verdictFor, isStale, navHealthLabel, navHealthWord, publishHealth, readHealth, resetHealth, showsNavHealthWord, subscribeHealth,
} from '../src/components/healthStatusStore';

/**
 * The sidebar's System health marker: the verdict it shows, the words that
 * carry it, and when it asks again.
 */

beforeEach(() => resetHealth());

describe('the shared verdict', () => {
  it('starts unchecked', () => {
    expect(readHealth().status).toBe('unchecked');
  });

  it('returns what was last published', () => {
    publishHealth({ status: 'fail', checkedAt: 1000 });
    expect(readHealth()).toEqual({ status: 'fail', checkedAt: 1000 });
  });

  it('tells subscribers when the verdict changes', () => {
    let calls = 0;
    subscribeHealth(() => { calls += 1; });
    publishHealth({ status: 'ok', checkedAt: 1 });
    expect(calls).toBe(1);
  });

  it('stops telling a subscriber that unsubscribed', () => {
    let calls = 0;
    const unsubscribe = subscribeHealth(() => { calls += 1; });
    unsubscribe();
    publishHealth({ status: 'ok', checkedAt: 1 });
    expect(calls).toBe(0);
  });
});

describe('isStale', () => {
  it('asks when there has never been an answer', () => {
    expect(isStale({ status: 'unchecked', checkedAt: 0 }, 5_000, 60_000)).toBe(true);
  });

  it('keeps a fresh answer', () => {
    expect(isStale({ status: 'ok', checkedAt: 10_000 }, 30_000, 60_000)).toBe(false);
  });

  it('asks again once the answer is as old as the limit', () => {
    expect(isStale({ status: 'ok', checkedAt: 10_000 }, 70_000, 60_000)).toBe(true);
  });
});

describe('the words', () => {
  it('names a healthy system', () => {
    expect(navHealthLabel('ok')).toBe('System health: Healthy');
  });

  it('names a problem', () => {
    expect(navHealthWord('fail')).toBe('Problem');
  });

  it('names a warning', () => {
    expect(navHealthWord('warn')).toBe('Watch');
  });

  it('says unknown when the check itself failed', () => {
    expect(navHealthWord('unavailable')).toBe('Unknown');
  });

  it('keeps a healthy system to a dot', () => {
    expect(showsNavHealthWord('ok')).toBe(false);
  });

  it('spells out a problem beside the link', () => {
    expect(showsNavHealthWord('fail')).toBe(true);
  });

  it('spells out a failed check beside the link', () => {
    expect(showsNavHealthWord('unavailable')).toBe(true);
  });
});

describe('whose verdict it is', () => {
  it('shows the verdict to the user it was checked for', () => {
    claimHealth('admin-a');
    publishHealth({ status: 'fail', checkedAt: 1 });
    expect(verdictFor(readHealth(), 'admin-a').status).toBe('fail');
  });

  it('never shows one user the verdict checked for another', () => {
    claimHealth('admin-a');
    publishHealth({ status: 'fail', checkedAt: 1 });
    expect(verdictFor(readHealth(), 'admin-b').status).toBe('unchecked');
  });

  it('forgets the verdict when another user claims the store', () => {
    claimHealth('admin-a');
    publishHealth({ status: 'fail', checkedAt: 1 });
    claimHealth('admin-b');
    expect(readHealth().status).toBe('unchecked');
  });

  it('keeps the verdict when the same user claims the store again', () => {
    claimHealth('admin-a');
    publishHealth({ status: 'warn', checkedAt: 1 });
    claimHealth('admin-a');
    expect(readHealth().status).toBe('warn');
  });
});
