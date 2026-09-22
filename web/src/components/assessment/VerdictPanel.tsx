import type { KeyboardEvent } from 'react';
import { Icon } from '../Icon';
import { VERDICTS, verdictLabel, verdictMark, type Verdict } from './verdictVocabulary';
import type { ConsequenceCopy } from './verdictFlowModel';
import { confidenceTicks, confidenceWord } from './verdictFlowModel';

/**
 * The decision, at the top of the page, where the reviewer ends up anyway.
 *
 * Two readings side by side: what the AI recommends, with its confidence and
 * the one thing it is not sure about, and the reviewer's own choice. Each
 * choice says what it will do before it does it — the consequence is not a
 * confirmation dialog after the fact, it is the sentence above the button.
 *
 * Marked with rules, brackets and icons rather than fills, so which verdict is
 * chosen is never carried by colour alone.
 */

export interface AiReading {
  readonly recommendation: string;
  readonly confidence: number | null;
  readonly caveat: string;
}

export interface VerdictPanelProps {
  /** Null while the organisation's blind-review policy withholds it. */
  readonly ai: AiReading | null;
  readonly candidate: string;
  readonly verdict: Verdict | '';
  readonly onVerdict: (verdict: Verdict) => void;
  readonly reason: string;
  readonly onReason: (reason: string) => void;
  readonly copy: ConsequenceCopy | null;
  readonly canSubmit: boolean;
  readonly submitting: boolean;
  readonly onSubmit: (applyToJourney: boolean) => void;
  /** Said plainly when the control is not the reviewer's to use. */
  readonly refusal: string;
}

function AiSide({ ai }: { readonly ai: AiReading | null }) {
  if (!ai) {
    return (
      <div className="v-ai" data-testid="verdict-ai-withheld">
        <p className="v-micro">The AI's reading</p>
        <p className="v-word is-withheld"><Icon name="eye-off" size={20} />Withheld</p>
        <p className="v-caveat">
          Your organisation asks for an independent read first. The recommendation and the scores
          appear once you have recorded your own verdict.
        </p>
      </div>
    );
  }
  const mark = VERDICTS.includes(ai.recommendation as Verdict) ? verdictMark(ai.recommendation as Verdict) : null;
  const label = VERDICTS.includes(ai.recommendation as Verdict) ? verdictLabel(ai.recommendation as Verdict) : 'No usable recommendation';
  return (
    <div className="v-ai" data-testid="verdict-ai">
      <p className="v-micro">The AI recommends</p>
      <p className={`v-word${mark ? ` is-${mark.tone}` : ''}`}>
        {mark && <Icon name={mark.icon} size={22} />}{label}
      </p>
      <p className="v-conf">
        <span className="v-ticks" role="img" aria-label={confidenceWord(ai.confidence)}>
          {confidenceTicks(ai.confidence).map((on, i) => <i key={i} className={on ? 'is-on' : undefined} />)}
        </span>
        <span>{confidenceWord(ai.confidence)}</span>
      </p>
      {ai.caveat && <p className="v-caveat" data-testid="verdict-caveat">{ai.caveat}</p>}
    </div>
  );
}

const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1,
};

/**
 * Arrow-key movement inside the decision group.
 *
 * The group looks like radios and is announced as radios, so it has to move
 * like radios. Roving tabIndex on its own is worse than nothing: it leaves one
 * button reachable by Tab and the other two reachable by nothing at all, so a
 * keyboard user could record Proceed and could not record anything else.
 * (Same rule, same reason, as the level picker on the blind review page.)
 */
function moveChoice(
  event: KeyboardEvent<HTMLDivElement>, value: Verdict | '', onChange: (next: Verdict) => void,
) {
  const step = ARROW_STEP[event.key];
  if (step === undefined) return;
  event.preventDefault();
  const at = VERDICTS.indexOf(value as Verdict);
  const next = at === -1 ? 0 : (at + step + VERDICTS.length) % VERDICTS.length;
  onChange(VERDICTS[next]);
  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
}

export function VerdictPanel(props: VerdictPanelProps) {
  const { verdict, copy, refusal } = props;
  const chosen = verdict !== '';

  return (
    <section className="verdict" aria-labelledby="verdict-heading" data-testid="verdict-panel">
      <h2 id="verdict-heading" className="sr-only">The verdict on this interview</h2>
      <AiSide ai={props.ai} />

      <div className="v-you">
        <p className="v-micro">Your decision</p>
        {refusal
          ? <p className="muted" data-testid="verdict-refusal">{refusal}</p>
          : (
            <>
              <div
                className="v-seg"
                role="radiogroup"
                aria-label="Your decision"
                onKeyDown={(e) => moveChoice(e, verdict, props.onVerdict)}
              >
                {VERDICTS.map((v) => {
                  const mark = verdictMark(v);
                  return (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={verdict === v}
                      // One tab stop for the group, as a radio group should have.
                      tabIndex={verdict === v || (!chosen && v === VERDICTS[0]) ? 0 : -1}
                      className={`v-choice is-${mark.tone}`}
                      data-testid={`verdict-${v}`}
                      onClick={() => props.onVerdict(v)}
                    >
                      <Icon name={mark.icon} size={15} />{verdictLabel(v)}
                    </button>
                  );
                })}
              </div>

              {!chosen && (
                <p className="muted v-hint">Pick one. You will see what happens before anything moves.</p>
              )}

              {chosen && copy && (
                <div className={`v-conseq is-${verdictMark(verdict).tone}`} data-testid="verdict-consequence" aria-live="polite">
                  <p className="v-conseq-line">{copy.sentence}</p>
                  <label htmlFor="verdict-reason">Why (required)</label>
                  <textarea
                    id="verdict-reason"
                    value={props.reason}
                    onChange={(e) => props.onReason(e.target.value)}
                    minLength={3}
                    placeholder="What in the evidence led you here?"
                  />
                  <div className="v-acts">
                    <button
                      type="button"
                      className="btn"
                      data-testid="verdict-act"
                      disabled={!props.canSubmit}
                      onClick={() => props.onSubmit(true)}
                    >
                      <Icon name={props.submitting ? 'hourglass' : 'send'} size={16} />
                      {props.submitting ? 'Recording…' : copy.act}
                    </button>
                    {copy.offersRecordOnly && (
                      <button
                        type="button"
                        className="btn secondary"
                        data-testid="verdict-record-only"
                        disabled={!props.canSubmit}
                        onClick={() => props.onSubmit(false)}
                      >
                        Just record it
                      </button>
                    )}
                  </div>
                  {copy.offersRecordOnly && <p className="v-conseq-note">{copy.recordOnlyNote}</p>}
                </div>
              )}
            </>
          )}
      </div>
    </section>
  );
}
