// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * The organisation's zone could not be read. It used to fall back to IST in
 * silence, so a New York organisation got IST suggested and legacy times shown
 * in IST with no sign anything was wrong. A failed read is now told apart
 * from "the organisation has not chosen a zone".
 */

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return { ...real, api: { ...real.api, get: http.get } };
});

const { useOrgTimeZoneStatus } = await import('../src/components/useOrgTimeZone');
const { orgTimeZoneLoadNotice } = await import('../src/components/orgTimeZone');

beforeEach(() => { http.get.mockReset(); });

describe('reading the organisation zone', () => {
  it('is the zone the organisation chose', async () => {
    http.get.mockResolvedValue({ timeZone: 'America/New_York' });
    const { result } = renderHook(() => useOrgTimeZoneStatus());
    await waitFor(() => expect(result.current).toEqual({ timeZone: 'America/New_York', failed: false }));
  });

  it('is IST, not a failure, when the organisation has not chosen one', async () => {
    http.get.mockResolvedValue({ timeZone: null });
    const { result } = renderHook(() => useOrgTimeZoneStatus());
    await waitFor(() => expect(result.current).toEqual({ timeZone: 'Asia/Kolkata', failed: false }));
  });

  it('says it failed when the zone could not be read', async () => {
    http.get.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useOrgTimeZoneStatus());
    await waitFor(() => expect(result.current.failed).toBe(true));
  });
});

describe('the notice for a zone that could not be read', () => {
  it('names the zone being assumed', () => {
    expect(orgTimeZoneLoadNotice()).toContain('Asia/Kolkata');
  });

  it('asks the recruiter to check the zone before booking', () => {
    expect(orgTimeZoneLoadNotice()).toMatch(/check the time zone/i);
  });
});
