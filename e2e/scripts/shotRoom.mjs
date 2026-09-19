// Visual check of the interview room against the running dev server: the
// interviewer speaking, then a code answer being written, at desktop, laptop
// and phone widths — and whether anything spills past the right edge.
// Reuses the e2e session and an E2E candidate (run the e2e suite first).
// Usage: node e2e/scripts/shotRoom.mjs <outDir>
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2] ?? '.';
const base = 'http://localhost:5173';
const statePath = resolve(import.meta.dirname, '../.auth/recruiter.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const csrf = state.cookies.find((c) => c.name === 'questor_csrf')?.value ?? '';
const sizes = [['1440x900', 1440, 900], ['1024x768', 1024, 768], ['375x812', 375, 812]];

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

const hr = await browser.newContext({ storageState: statePath, baseURL: base });
const list = await (await hr.request.get('/api/candidates')).json();
const candidate = list.candidates.find((c) => /^E2E Candidate/.test(c.fullName ?? c.name ?? ''));
if (!candidate) throw new Error('No E2E candidate found; run the e2e suite first.');
const headers = { 'X-CSRF-Token': csrf };
const created = await (await hr.request.post('/api/interviews', {
  headers, data: { candidateId: candidate.id, interviewer: 'maya', persona: { tone: 'warm' }, recordingRequested: true },
})).json();
const invite = await (await hr.request.post(`/api/interviews/${created.session.id}/invite`, { headers, data: {} })).json();
const portalUrl = invite.invitation.portalUrl;

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
await ctx.grantPermissions(['microphone']);
await ctx.addInitScript(() => {
  // Headless has no voices. This stand-in "speaks" at a natural pace, sending
  // the word boundaries a real voice would, and holds the last question open
  // until the script releases it, so the speaking state can be photographed.
  const held = [];
  window.__releaseSpeech = () => { while (held.length) held.shift()(); };
  const synth = {
    speak(u) {
      const starts = [...u.text.matchAll(/\S+/g)].map((m) => m.index ?? 0);
      setTimeout(() => u.onstart?.(new Event('start')), 30);
      let i = 0;
      const timer = setInterval(() => {
        u.onboundary?.({ name: 'word', charIndex: starts[i % starts.length] });
        i += 1;
        if (i >= starts.length * 3 && !window.__holdSpeech) finish();
      }, 380);
      const finish = () => { clearInterval(timer); u.onend?.(new Event('end')); };
      if (window.__holdSpeech) held.push(finish);
    },
    cancel() {}, pause() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false, onvoiceschanged: null,
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
  window.__holdSpeech = true;
  // A recognizer that hears a sentence, so the voice box has live words.
  class FakeRecognition {
    start() {
      const words = 'I lead the data platform team at a payments company'.split(' ');
      let n = 0;
      this.t = setInterval(() => {
        n = Math.min(words.length, n + 1);
        this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: words.slice(0, n).join(' ') }, isFinal: false, length: 1 }] });
      }, 300);
    }
    stop() { clearInterval(this.t); this.onend?.(); }
    abort() { clearInterval(this.t); this.onend?.(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
});
const page = await ctx.newPage();
await page.goto(portalUrl, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Continue' }).click();
await page.getByLabel(/I understand this first round/).check();
await page.getByLabel(/I consent to my voice being captured/).check();
await page.getByRole('button', { name: /I consent/ }).click();
await page.getByRole('button', { name: /Continue anyway/ }).click();
await page.getByRole('button', { name: 'Join interview' }).click();
await page.getByTestId('room-interviewer').waitFor();

async function overflow() {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const contained = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden') && p.getBoundingClientRect().right <= vw + 1) return true;
      }
      return false;
    };
    const spill = [...document.querySelectorAll('.room *')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 && !contained(el); })
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}`);
    return { vw, scrollWidth: document.documentElement.scrollWidth, spill: spill.slice(0, 5) };
  });
}

async function shoot(label) {
  for (const [name, width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(out, `room-${label}-${name}.png`) });
    const o = await overflow();
    console.log(`${label} ${name}: scrollWidth=${o.scrollWidth} vw=${o.vw} spill=${o.spill.join(', ') || 'none'}`);
  }
}

// The opening turn, held mid-sentence.
await page.waitForTimeout(2500);
await shoot('speaking');

// Let the interviewer finish; the candidate answers aloud, then switches to code.
await page.evaluate(() => { window.__holdSpeech = false; window.__releaseSpeech(); });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(2500);
await shoot('answering');
await page.getByRole('button', { name: 'Code', exact: true }).click();
await page.getByLabel('Your answer').fill(
  "WITH days AS (\n  SELECT DISTINCT user_id, event_date\n  FROM events\n)\nSELECT user_id, COUNT(*) AS active_days\nFROM days\nGROUP BY user_id;",
);
await shoot('code');

// A phone with the keyboard open: the visible height is roughly halved. The
// editor, the mode switch and Send must all stay on screen.
await page.setViewportSize({ width: 375, height: 460 });
await page.getByLabel('Your answer').focus();
await page.waitForTimeout(700);
await page.screenshot({ path: resolve(out, 'room-code-375x460-keyboard.png') });
const sendBox = await page.getByRole('button', { name: 'Send' }).boundingBox();
console.log(`code 375x460 keyboard: send visible=${sendBox !== null && sendBox.y + sendBox.height <= 460}`);

await ctx.close();
await hr.close();
await browser.close();
