// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { EMPTY_SCHEDULE, TimeZoneDateTimePicker } from '../src/components/TimeZoneDateTimePicker';
import type { ScheduleDraft } from '../src/components/zonedScheduleModel';

/**
 * Which clock the picker starts on.
 *
 * The owner's rule is that HR records where the candidate is and interviews are
 * booked on that clock. The trap is timing: the organisation's zone and the
 * candidate's arrive from two different requests, and the first version of this
 * picker filled the field the moment the organisation's landed — permanently.
 * Whenever the organisation's answered first, HR who HAD recorded the
 * candidate's zone was silently given the organisation's instead, which is the
 * exact substitution the rest of this work exists to stop.
 */

afterEach(cleanup);

/** The picker with a real draft behind it, so its one-shot fill can be observed. */
function Harness({ orgZone, candidate }: {
  readonly orgZone: string | null | undefined;
  readonly candidate?: { readonly timeZone: string | null; readonly loaded: boolean };
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(EMPTY_SCHEDULE);
  return createElement(TimeZoneDateTimePicker, { idPrefix: 'test', value: draft, onChange: setDraft, orgZone, candidate });
}

const zoneField = () => screen.getByLabelText('Time zone') as HTMLInputElement;

async function mount(props: Parameters<typeof Harness>[0]) {
  const view = render(createElement(Harness, props));
  return {
    rerender: async (next: Parameters<typeof Harness>[0]) => {
      await act(async () => { view.rerender(createElement(Harness, next)); });
    },
  };
}

describe('the zone a booking starts on', () => {
  it('is the candidate’s when it is already known', async () => {
    await mount({ orgZone: 'Asia/Kolkata', candidate: { timeZone: 'America/New_York', loaded: true } });

    expect(zoneField().value).toBe('America/New_York');
  });

  it('is the organisation’s when HR has recorded nothing for the candidate', async () => {
    await mount({ orgZone: 'Asia/Kolkata', candidate: { timeZone: null, loaded: true } });

    expect(zoneField().value).toBe('Asia/Kolkata');
  });

  it('waits for the candidate’s answer rather than settling on the organisation’s', async () => {
    const view = await mount({ orgZone: 'Asia/Kolkata', candidate: { timeZone: null, loaded: false } });

    expect(zoneField().value).toBe('');

    await view.rerender({ orgZone: 'Asia/Kolkata', candidate: { timeZone: 'America/New_York', loaded: true } });

    expect(zoneField().value).toBe('America/New_York');
  });

  it('does not wait where the booking is not about a candidate at all', async () => {
    await mount({ orgZone: 'Asia/Kolkata' });

    expect(zoneField().value).toBe('Asia/Kolkata');
  });

  it('says out loud that it is standing in for a zone nobody recorded', async () => {
    await mount({ orgZone: 'Asia/Kolkata', candidate: { timeZone: null, loaded: true } });

    expect(screen.getByTestId('test-candidate-zone-unset').textContent).toContain('Asia/Kolkata');
  });

  it('says nothing about standing in once the candidate’s zone is known', async () => {
    await mount({ orgZone: 'Asia/Kolkata', candidate: { timeZone: 'America/New_York', loaded: true } });

    expect(screen.queryByTestId('test-candidate-zone-unset')).toBeNull();
  });

  it('says nothing about standing in while the answer is still coming', async () => {
    await mount({ orgZone: 'Asia/Kolkata', candidate: { timeZone: null, loaded: false } });

    expect(screen.queryByTestId('test-candidate-zone-unset')).toBeNull();
  });

  // Clearing the field to search must not have it refilled under the typist.
  it('fills the field once and then leaves it alone', async () => {
    const view = await mount({ orgZone: 'Asia/Kolkata', candidate: { timeZone: 'America/New_York', loaded: true } });
    await act(async () => { zoneField().focus(); });
    const field = zoneField();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, '');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await view.rerender({ orgZone: 'Asia/Kolkata', candidate: { timeZone: 'America/New_York', loaded: true } });

    expect(zoneField().value).toBe('');
  });
});

describe('a picker with no organisation zone yet', () => {
  it('fills nothing, because there is nothing honest to fill it with', async () => {
    await mount({ orgZone: undefined, candidate: { timeZone: null, loaded: true } });

    expect(zoneField().value).toBe('');
  });
});
