import { describe, it, expect } from 'vitest';
import {
  meetingLinkProblem, meetingSummary, providerLabel, safeMeetingUrl, scheduleHint, type RoundMeetingView,
} from '../src/components/roundMeetingModel';

const linked: RoundMeetingView = { provider: 'zoom', status: 'LINKED', url: 'https://zoom.us/j/1', error: null };

describe('safeMeetingUrl', () => {
  it('keeps an https link', () => {
    expect(safeMeetingUrl('https://zoom.us/j/1')).toBe('https://zoom.us/j/1');
  });

  it('drops a javascript: link', () => {
    expect(safeMeetingUrl('javascript:alert(1)')).toBeNull();
  });

  it('drops an http link', () => {
    expect(safeMeetingUrl('http://zoom.us/j/1')).toBeNull();
  });

  it('drops a missing link', () => {
    expect(safeMeetingUrl(null)).toBeNull();
  });
});

describe('meetingLinkProblem', () => {
  it('accepts a full https link', () => {
    expect(meetingLinkProblem(' https://meet.google.com/abc-defg-hij ')).toBeNull();
  });

  it('asks for https', () => {
    expect(meetingLinkProblem('http://meet.example.com')).toMatch(/https:\/\//);
  });

  it('asks for a whole link when given a fragment', () => {
    expect(meetingLinkProblem('abc-defg-hij')).toMatch(/full meeting link/);
  });
});

describe('providerLabel', () => {
  it('names each provider', () => {
    expect(['manual', 'teams', 'zoom', 'meet'].map(providerLabel)).toEqual(['Manual link', 'Microsoft Teams', 'Zoom', 'Google Meet']);
  });

  it('falls back to a neutral label', () => {
    expect(providerLabel(null)).toBe('Meeting');
  });
});

describe('meetingSummary', () => {
  it('shows the join link of a created meeting', () => {
    expect(meetingSummary(linked, 'SCHEDULED')).toMatchObject({ link: 'https://zoom.us/j/1', canRetry: false, canAddLink: false, tone: 'ok' });
  });

  it('offers retry and a manual link when creation failed', () => {
    const failed: RoundMeetingView = { provider: 'zoom', status: 'NEEDS_LINK', url: null, error: 'Zoom is rate-limiting requests.' };
    expect(meetingSummary(failed, 'SCHEDULED')).toMatchObject({ canRetry: true, canAddLink: true, tone: 'error', text: 'Zoom is rate-limiting requests.' });
  });

  it('offers only a manual link when no provider is selected', () => {
    const none: RoundMeetingView = { provider: 'manual', status: 'NEEDS_LINK', url: null, error: null };
    expect(meetingSummary(none, 'SCHEDULED')).toMatchObject({ canRetry: false, canAddLink: true, tone: 'info' });
  });

  it('offers to create a meeting once the organisation has a working provider', () => {
    const none: RoundMeetingView = { provider: 'manual', status: 'NEEDS_LINK', url: null, error: null };
    expect(meetingSummary(none, 'SCHEDULED', true).canRetry).toBe(true);
  });

  it('offers both fallbacks for a creation that never finished', () => {
    const stuck: RoundMeetingView = { provider: 'zoom', status: 'CREATING', url: null, error: null, stuck: true };
    expect(meetingSummary(stuck, 'SCHEDULED')).toMatchObject({ canRetry: true, canAddLink: true, tone: 'error' });
  });

  it('offers retry for a meeting left at the old time', () => {
    const stale: RoundMeetingView = { ...linked, status: 'OUT_OF_SYNC', error: 'The round moved, but the Zoom meeting still has the old time.' };
    expect(meetingSummary(stale, 'SCHEDULED')).toMatchObject({ canRetry: true, canAddLink: false, link: 'https://zoom.us/j/1' });
  });

  it('offers retry for a meeting a cancellation could not remove', () => {
    const leftover: RoundMeetingView = { ...linked, status: 'CANCEL_FAILED', error: 'could not be removed' };
    expect(meetingSummary(leftover, 'CANCELLED')).toMatchObject({ canRetry: true, canAddLink: false, link: null });
  });

  it('hides the link of a cancelled round', () => {
    expect(meetingSummary({ ...linked, status: 'CANCELLED' }, 'CANCELLED')).toMatchObject({ link: null, canRetry: false });
  });

  it('never offers to add a link to a finished round', () => {
    const none: RoundMeetingView = { provider: 'manual', status: 'NEEDS_LINK', url: null, error: null };
    expect(meetingSummary(none, 'COMPLETED').canAddLink).toBe(false);
  });

  it('never renders an unsafe link even if the server sent one', () => {
    expect(meetingSummary({ ...linked, url: 'javascript:alert(1)' }, 'SCHEDULED').link).toBeNull();
  });

  it('says a meeting is being created', () => {
    expect(meetingSummary({ ...linked, status: 'CREATING', url: null }, 'SCHEDULED').text).toMatch(/being created/);
  });
});

describe('scheduleHint', () => {
  it('says the provider will create the meeting', () => {
    expect(scheduleHint({ provider: 'teams', label: 'Microsoft Teams', configured: true })).toMatch(/Microsoft Teams meeting will be created/);
  });

  it('warns when the provider is not set up', () => {
    expect(scheduleHint({ provider: 'zoom', label: 'Zoom', configured: false })).toMatch(/not fully set up/);
  });

  it('asks for a link when no provider is selected', () => {
    expect(scheduleHint({ provider: 'manual', label: 'Manual link', configured: true })).toMatch(/Paste the meeting link/);
  });

  it('asks for a link when the provider is unknown', () => {
    expect(scheduleHint(null)).toMatch(/Paste the meeting link/);
  });
});
