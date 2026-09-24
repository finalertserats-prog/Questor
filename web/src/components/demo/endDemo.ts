import { api } from '../../api/client';

let ending = false;

/**
 * End the demo on the server, then leave for the closing page. One place for
 * it, because the demo bar and the guided tour both offer it: the server
 * ends the session at once (the token stops working) and the demo-interview
 * lane's feedback step takes over at /demo/ended.
 */
export async function endDemo(): Promise<void> {
  if (ending) return;
  ending = true;
  try { await api.post('/demo/end', {}); } catch { /* the session is ending either way */ }
  window.location.assign('/demo/ended');
}

/**
 * The candidate side of the sample interview, in a new tab that cannot reach
 * back into this console. Opened before the request so the browser treats it
 * as the click it was, not a pop-up.
 */
export async function openSampleInterview(): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const { portalUrl } = await api.get<{ portalUrl: string }>('/demo/interview');
    if (tab) tab.location.href = portalUrl; else window.location.assign(portalUrl);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
