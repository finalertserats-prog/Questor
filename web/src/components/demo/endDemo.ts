import { api } from '../../api/client';

let ending = false;

/**
 * End the demo on the server, then leave for the feedback step.
 *
 * One place for it, because the demo bar and the guided tour both offer it.
 *
 * THE ORDER MATTERS. The feedback form runs SIGNED OUT — /demo/end clears the
 * session cookie at once, and a form that authenticated as the visitor would
 * be asking a signed-out browser to prove who it was. So the ticket is taken
 * while the session is still good, and it is the credential the form uses.
 *
 * Failing to get one is not worth stopping for: the demo still ends and the
 * visitor goes to the ordinary closing page, which is where this went before
 * the feedback step existed.
 */
export async function endDemo(): Promise<void> {
  if (ending) return;
  ending = true;
  let ticket = '';
  try {
    const issued = await api.post<{ token: string }>('/demo/interview/feedback-ticket', {});
    ticket = issued.token;
  } catch { /* no feedback step for this one */ }
  try { await api.post('/demo/end', {}); } catch { /* the session is ending either way */ }
  window.location.assign(ticket ? `/demo/feedback/${ticket}` : '/demo/ended');
}

/*
 * `openSampleInterview` lived here: a new tab straight into the sample
 * interview's portal link. Both callers — the demo bar and the tour's closing
 * card — now go to /demo/interview instead, which explains the fifteen
 * minutes before anything starts and is the only path that plans the sitting,
 * claims its model allowance and records the run.
 */
