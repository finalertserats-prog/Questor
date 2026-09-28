/**
 * Voice previews on the interview setup form, kept free of React and of the
 * browser's audio APIs so the rules can be tested (web/tests/voicePreviewModel.test.ts):
 *
 *  - nothing plays until someone clicks — never on load;
 *  - one preview at a time: a second click stops the first;
 *  - clicking the playing preview again stops it.
 */

/** Something playing that can be stopped. */
export interface PreviewSound {
  stop(): void;
}

/** What the server answered: its own audio, or text for the browser voice. */
export type PreviewSource =
  | { readonly kind: 'audio'; readonly url: string }
  | { readonly kind: 'browser'; readonly text: string; readonly hint: string };

export interface PreviewDeps {
  fetchPreview(interviewerId: string): Promise<PreviewSource>;
  playAudio(url: string, onEnd: () => void): PreviewSound;
  speakBrowser(text: string, hint: string, onEnd: () => void): PreviewSound;
}

export interface VoicePreview {
  play(interviewerId: string): Promise<void>;
  stop(): void;
  playingId(): string | null;
}

export function createVoicePreview(deps: PreviewDeps, onChange?: (playingId: string | null) => void): VoicePreview {
  let current: { id: string; sound: PreviewSound | null } | null = null;
  // Each click takes a ticket; a fetch that returns after a newer click is
  // dropped, so a slow first preview can never start over the second.
  let ticket = 0;

  const set = (next: typeof current) => {
    current = next;
    onChange?.(current?.id ?? null);
  };

  const stop = () => {
    ticket++;
    current?.sound?.stop();
    if (current) set(null);
  };

  const play = async (interviewerId: string) => {
    const wasPlaying = current?.id === interviewerId;
    stop();
    if (wasPlaying) return;
    const mine = ++ticket;
    set({ id: interviewerId, sound: null });
    let source: PreviewSource;
    try {
      source = await deps.fetchPreview(interviewerId);
    } catch (err) {
      // Never leave a button stuck on "Stop" for a preview that is not playing.
      if (mine === ticket) set(null);
      throw err;
    }
    if (mine !== ticket) return;
    const finished = () => { if (mine === ticket && current?.id === interviewerId) set(null); };
    const sound = source.kind === 'audio'
      ? deps.playAudio(source.url, finished)
      : deps.speakBrowser(source.text, source.hint, finished);
    if (mine === ticket && current?.id === interviewerId) current = { id: interviewerId, sound };
    else sound.stop();
  };

  return { play, stop, playingId: () => current?.id ?? null };
}
