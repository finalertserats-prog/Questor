import { describe, it, expect } from 'vitest';
import { createVoicePreview, type PreviewDeps, type PreviewSound } from '../src/components/voicePreviewModel';

// One preview at a time, and nothing plays until someone clicks.

interface FakeSound extends PreviewSound { id: string; stopped: boolean; finish(): void }

function harness(opts: { serverAudio?: boolean } = {}) {
  const started: FakeSound[] = [];
  const spoken: Array<{ text: string; hint: string }> = [];
  let speechCancelled = 0;
  const deps: PreviewDeps = {
    async fetchPreview(id) {
      return opts.serverAudio === false
        ? { kind: 'browser', text: `Hi, I'm ${id}, an AI interviewer from Questor.`, hint: 'female:0' }
        : { kind: 'audio', url: `blob:${id}` };
    },
    playAudio(url, onEnd) {
      const sound: FakeSound = { id: url.replace('blob:', ''), stopped: false, stop() { this.stopped = true; }, finish: onEnd };
      started.push(sound);
      return sound;
    },
    speakBrowser(text, hint, onEnd) {
      spoken.push({ text, hint });
      return { stop() { speechCancelled++; }, finish: onEnd } as PreviewSound;
    },
  };
  return { deps, started, spoken, cancelled: () => speechCancelled };
}

describe('voice preview player', () => {
  it('plays nothing until asked', () => {
    const h = harness();
    createVoicePreview(h.deps);
    expect(h.started).toHaveLength(0);
  });

  it('plays the clicked interviewer', async () => {
    const h = harness();
    const preview = createVoicePreview(h.deps);
    await preview.play('maya');
    expect(h.started.map((s) => s.id)).toEqual(['maya']);
  });

  it('reports which interviewer is playing', async () => {
    const h = harness();
    const preview = createVoicePreview(h.deps);
    await preview.play('maya');
    expect(preview.playingId()).toBe('maya');
  });

  it('stops the current preview when another is clicked', async () => {
    const h = harness();
    const preview = createVoicePreview(h.deps);
    await preview.play('maya');
    await preview.play('theo');
    expect([h.started[0].stopped, preview.playingId()]).toEqual([true, 'theo']);
  });

  it('stops when the playing preview is clicked again', async () => {
    const h = harness();
    const preview = createVoicePreview(h.deps);
    await preview.play('maya');
    await preview.play('maya');
    expect([h.started[0].stopped, preview.playingId()]).toEqual([true, null]);
  });

  it('clears the playing state when the clip ends', async () => {
    const h = harness();
    const preview = createVoicePreview(h.deps);
    await preview.play('maya');
    h.started[0].finish();
    expect(preview.playingId()).toBe(null);
  });

  it('uses the browser voice picked by the hint when the server has none', async () => {
    const h = harness({ serverAudio: false });
    const preview = createVoicePreview(h.deps);
    await preview.play('elena');
    expect(h.spoken).toEqual([{ text: "Hi, I'm elena, an AI interviewer from Questor.", hint: 'female:0' }]);
  });

  it('notifies listeners of every change', async () => {
    const h = harness();
    const seen: Array<string | null> = [];
    const preview = createVoicePreview(h.deps, (id) => seen.push(id));
    await preview.play('maya');
    preview.stop();
    expect(seen).toEqual(['maya', null]);
  });

  it('clears the playing state when the preview cannot be fetched', async () => {
    const h = harness();
    const failing: PreviewDeps = { ...h.deps, fetchPreview: () => Promise.reject(new Error('offline')) };
    const preview = createVoicePreview(failing);
    await preview.play('maya').catch(() => undefined);
    expect(preview.playingId()).toBe(null);
  });

  it('ignores a slow fetch that a newer click has overtaken', async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const slow: PreviewDeps = {
      ...h.deps,
      fetchPreview: (id) => id === 'maya'
        ? new Promise((resolve) => { release = () => resolve({ kind: 'audio', url: 'blob:maya' }); })
        : h.deps.fetchPreview(id),
    };
    const preview = createVoicePreview(slow);
    const first = preview.play('maya');
    await preview.play('theo');
    release();
    await first;
    expect([h.started.map((s) => s.id), preview.playingId()]).toEqual([['theo'], 'theo']);
  });
});
