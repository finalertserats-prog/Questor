// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The suggestion as a person meets it: offered, taken, typed over, tidied —
 * and the field where it is deliberately not offered at all.
 */

const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return { ...real, api: { ...real.api, post: http.post } };
});

const { SuggestedDraft, NoDraftNote } = await import('../src/components/drafts/SuggestedDraft');
const { TidyUp } = await import('../src/components/drafts/TidyUp');
const { useFieldDraft, useTidyUp, _resetDraftPolicyCache } = await import('../src/components/drafts/useFieldDraft');

const DRAFT = 'A senior engineer on the payments platform, owning the services that move money end to end.';

/** A field with a draft offered under it, as RoleCreate wires one. */
function Field() {
  const [value, setValue] = useState('');
  const draft = useFieldDraft({ field: 'role_summary', context: 'Senior Backend Engineer', value, onAccept: setValue });
  return h('div', null,
    h('label', { htmlFor: 'f' }, 'Role summary'),
    h('textarea', {
      id: 'f',
      value,
      'aria-describedby': draft.describedBy,
      onFocus: draft.onFocus,
      onKeyDown: draft.onKeyDown,
      onChange: (e: { target: { value: string } }) => { draft.onTyped(); setValue(e.target.value); },
    }),
    h(SuggestedDraft, { draft }));
}

function TidyField({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const tidy = useTidyUp({ field: 'verdict_reason', value, onAccept: setValue });
  return h('div', null,
    h('textarea', { id: 'r', value, onChange: (e: { target: { value: string } }) => setValue(e.target.value) }),
    h(NoDraftNote, { field: 'verdict_reason' }),
    h(TidyUp, { tidy, value }));
}

beforeEach(() => {
  http.post.mockReset();
  _resetDraftPolicyCache();
});
afterEach(cleanup);

const box = () => screen.getByLabelText('Role summary') as HTMLTextAreaElement;

describe('a draft offered under an empty field', () => {
  beforeEach(() => { http.post.mockResolvedValue({ text: DRAFT, disabled: false }); });

  it('asks for nothing until the field is focused', () => {
    render(h(Field));
    expect(http.post).not.toHaveBeenCalled();
  });

  it('shows the draft as real, readable text in the page', async () => {
    render(h(Field));
    fireEvent.focus(box());
    await waitFor(() => expect(screen.getByTestId('draft-text').textContent).toBe(DRAFT));
  });

  it('never carries the draft in the placeholder attribute', async () => {
    render(h(Field));
    fireEvent.focus(box());
    await screen.findByTestId('draft-text');
    expect(box().getAttribute('placeholder')).toBeNull();
  });

  it('leaves the field empty until the person takes it — nothing is filled in for them', async () => {
    render(h(Field));
    fireEvent.focus(box());
    await screen.findByTestId('draft-text');
    expect(box().value).toBe('');
  });

  it('announces itself politely rather than interrupting', async () => {
    render(h(Field));
    fireEvent.focus(box());
    await screen.findByTestId('draft-text');
    const live = document.querySelector('[role="status"][aria-live="polite"]');
    expect(live?.textContent).toContain('Tab');
  });

  it('does not take focus away from the field the person is in', async () => {
    render(h(Field));
    const field = box();
    field.focus();
    fireEvent.focus(field);
    await screen.findByTestId('draft-text');
    expect(document.activeElement).toBe(field);
  });

  it('puts the text in the field when "Use this" is pressed', async () => {
    render(h(Field));
    fireEvent.focus(box());
    fireEvent.click(await screen.findByTestId('draft-accept'));
    await waitFor(() => expect(box().value).toBe(DRAFT));
  });

  it('accepts on Tab while the field is still empty', async () => {
    render(h(Field));
    fireEvent.focus(box());
    await screen.findByTestId('draft-text');
    fireEvent.keyDown(box(), { key: 'Tab' });
    await waitFor(() => expect(box().value).toBe(DRAFT));
  });

  it('records the acceptance, so an organisation can see what was AI-assisted', async () => {
    render(h(Field));
    fireEvent.focus(box());
    fireEvent.click(await screen.findByTestId('draft-accept'));
    await waitFor(() => expect(http.post.mock.calls.some(([path]) => path === '/drafts/accepted')).toBe(true));
  });

  it('goes away when the person starts typing their own', async () => {
    render(h(Field));
    fireEvent.focus(box());
    await screen.findByTestId('draft-text');
    fireEvent.change(box(), { target: { value: 'My own words instead.' } });
    expect(screen.queryByTestId('draft-text')).toBeNull();
  });

  it('goes away when dismissed, and does not come back by itself', async () => {
    render(h(Field));
    fireEvent.focus(box());
    fireEvent.click(await screen.findByTestId('draft-dismiss'));
    fireEvent.focus(box());
    expect(screen.queryByTestId('draft-text')).toBeNull();
  });
});

describe('when there is nothing good to show', () => {
  it('shows no suggestion rather than an empty one', async () => {
    http.post.mockResolvedValue({ text: '', disabled: false });
    render(h(Field));
    fireEvent.focus(box());
    await screen.findByTestId('draft-dismissed');
    expect(screen.queryByTestId('draft-text')).toBeNull();
  });

  it('shows no error when the call fails — a field with no draft is just a field', async () => {
    http.post.mockRejectedValue(new Error('gateway'));
    render(h(Field));
    fireEvent.focus(box());
    await screen.findByTestId('draft-dismissed');
    expect(screen.queryByText(/gateway/)).toBeNull();
  });

  it('stops asking once the organisation has said drafting is off', async () => {
    http.post.mockResolvedValue({ text: '', disabled: true });
    render(h(Field));
    fireEvent.focus(box());
    await waitFor(() => expect(http.post).toHaveBeenCalledTimes(1));
    cleanup();
    render(h(Field));
    fireEvent.focus(box());
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

describe('a suggestion asked for again', () => {
  it('is refused over text the person has already written', async () => {
    http.post.mockResolvedValue({ text: DRAFT, disabled: false });
    render(h(Field));
    fireEvent.focus(box());
    await screen.findByTestId('draft-text');
    fireEvent.change(box(), { target: { value: 'My own words instead.' } });
    const asked = http.post.mock.calls.length;
    const offerAgain = screen.queryByText('Offer one');
    if (offerAgain) fireEvent.click(offerAgain);
    expect(http.post.mock.calls.length).toBe(asked);
    expect(box().value).toBe('My own words instead.');
  });
});

describe('the reviewer\'s own verdict reason', () => {
  it('says plainly that no draft is offered, and why', () => {
    render(h(TidyField, { initial: '' }));
    expect(screen.getByTestId('no-draft-note').textContent).toContain('rubber stamp');
  });

  it('offers nothing to tidy before they have written something', () => {
    render(h(TidyField, { initial: '' }));
    expect(screen.queryByTestId('tidy-run')).toBeNull();
  });

  it('offers to tidy once they have written their own words', () => {
    render(h(TidyField, { initial: 'he gave the whole diagnosis at 18:40, thats a 4 not a 2' }));
    expect(screen.getByTestId('tidy-run')).toBeTruthy();
  });

  it('shows the before and after rather than replacing their words silently', async () => {
    http.post.mockResolvedValue({ text: 'He gave the whole diagnosis at 18:40. That is a 4, not a 2.', disabled: false });
    render(h(TidyField, { initial: 'he gave the whole diagnosis at 18:40, thats a 4 not a 2' }));
    fireEvent.click(screen.getByTestId('tidy-run'));
    const panel = await screen.findByTestId('tidy-panel');
    expect(panel.textContent).toContain('Yours');
    expect(panel.textContent).toContain('Tidied');
  });

  it('keeps their version when they say so', async () => {
    http.post.mockResolvedValue({ text: 'A tidied sentence about the evidence.', disabled: false });
    render(h(TidyField, { initial: 'a messy sentence about the evidence here' }));
    fireEvent.click(screen.getByTestId('tidy-run'));
    fireEvent.click(await screen.findByTestId('tidy-discard'));
    expect((document.getElementById('r') as HTMLTextAreaElement).value).toBe('a messy sentence about the evidence here');
  });

  it('drops a tidy of a sentence they have since changed', async () => {
    let resolve: (value: { text: string; disabled: boolean }) => void = () => undefined;
    http.post.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(h(TidyField, { initial: 'a messy sentence about the evidence here' }));
    fireEvent.click(screen.getByTestId('tidy-run'));
    fireEvent.change(document.getElementById('r') as HTMLTextAreaElement, {
      target: { value: 'completely different words now, written after' },
    });
    resolve({ text: 'A tidied sentence about the evidence.', disabled: false });
    await waitFor(() => expect(screen.queryByTestId('tidy-panel')).toBeNull());
    expect((document.getElementById('r') as HTMLTextAreaElement).value)
      .toBe('completely different words now, written after');
  });

  it('takes the tidied version only when they keep it', async () => {
    http.post.mockResolvedValue({ text: 'A tidied sentence about the evidence.', disabled: false });
    render(h(TidyField, { initial: 'a messy sentence about the evidence here' }));
    fireEvent.click(screen.getByTestId('tidy-run'));
    fireEvent.click(await screen.findByTestId('tidy-keep'));
    await waitFor(() => expect((document.getElementById('r') as HTMLTextAreaElement).value)
      .toBe('A tidied sentence about the evidence.'));
  });
});
