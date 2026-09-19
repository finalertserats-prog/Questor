import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { interviewerChoices, type PublicInterviewer } from './interviewerModel';
import { createVoicePreview, type PreviewDeps, type VoicePreview } from './voicePreviewModel';

// The speech module touches `window` when it loads, so it is fetched on the
// first preview click rather than imported here: this component sits on the
// candidate page, whose pure helpers are imported by node tests.
let speechDeps: PreviewDeps | null = null;
function loadedDeps(): PreviewDeps {
  // Playing only ever follows a fetch, which is what loads the module.
  if (!speechDeps) throw new Error('The speech module has not loaded yet.');
  return speechDeps;
}
const lazyPreviewDeps: PreviewDeps = {
  async fetchPreview(id) {
    speechDeps ??= (await import('../speech')).browserPreviewDeps;
    return speechDeps.fetchPreview(id);
  },
  playAudio: (url, onEnd) => loadedDeps().playAudio(url, onEnd),
  speakBrowser: (text, hint, onEnd) => loadedDeps().speakBrowser(text, hint, onEnd),
};

interface InterviewerSelectorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/**
 * "AI interviewer" on the interview setup form: Random (recommended) or one of
 * the five, each with a voice sample. Names and voices only — the interviewers
 * are otherwise identical, so there is nothing else to describe. Previews play
 * only on click, one at a time.
 */
export function InterviewerSelector({ value, onChange }: InterviewerSelectorProps) {
  const [list, setList] = useState<readonly PublicInterviewer[]>([]);
  const [loadError, setLoadError] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');
  const preview = useRef<VoicePreview | null>(null);

  if (!preview.current) preview.current = createVoicePreview(lazyPreviewDeps, setPlayingId);

  useEffect(() => {
    let cancelled = false;
    api.get<{ interviewers: PublicInterviewer[] }>('/interviewers')
      .then((res) => { if (!cancelled) setList(res.interviewers); })
      .catch(() => { if (!cancelled) setLoadError('The interviewer list could not be loaded. Random still works.'); });
    const player = preview.current;
    return () => { cancelled = true; player?.stop(); };
  }, []);

  const choices = useMemo(() => interviewerChoices(list), [list]);

  const togglePreview = useCallback((id: string) => {
    setPreviewError('');
    preview.current?.play(id).catch(() => setPreviewError('That voice sample could not be played.'));
  }, []);

  return (
    <fieldset className="interviewer-select" data-testid="interviewer-select">
      <legend className="field-label">AI interviewer</legend>
      <ul className="interviewer-options">
        {choices.map((choice) => {
          const inputId = `interviewer-${choice.value}`;
          const selected = value === choice.value;
          const playing = playingId === choice.value;
          return (
            <li key={choice.value} className={`interviewer-option${selected ? ' is-selected' : ''}`}>
              <input
                id={inputId}
                type="radio"
                name="ai-interviewer"
                value={choice.value}
                checked={selected}
                onChange={() => onChange(choice.value)}
              />
              <label htmlFor={inputId} className="interviewer-option-label">
                <span className="interviewer-avatar" aria-hidden="true">{choice.previewable ? choice.label.charAt(0) : '?'}</span>
                <span className="interviewer-option-name">{choice.label}</span>
              </label>
              {choice.previewable && (
                <button
                  type="button"
                  className="btn secondary sm interviewer-preview"
                  aria-pressed={playing}
                  aria-label={playing ? `Stop ${choice.label} voice preview` : `Preview ${choice.label} voice`}
                  onClick={() => togglePreview(choice.value)}
                >
                  {playing ? '■ Stop' : '▶ Preview voice'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {loadError && <p className="muted small" role="status">{loadError}</p>}
      {previewError && <p className="muted small" role="status">{previewError}</p>}
    </fieldset>
  );
}
