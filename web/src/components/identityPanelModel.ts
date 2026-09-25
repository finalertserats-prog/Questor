import { formatDateTime } from './dateFormat';

/**
 * The "Identity & integrity" panel on the review page (server
 * services/identityPanel.ts). Wording lives here so it can be tested
 * (web/tests/identityPanelModel.test.ts).
 *
 * The panel reports and never decides: no verdict, no score, no reject
 * button. Its words are neutral on purpose. A code that was not entered or an
 * answer that sounds thin has ordinary explanations, and the reader is a
 * person who weighs it alongside everything else.
 */

export type CodeState = 'confirmed' | 'not_confirmed' | 'not_run' | 'not_run_demo' | 'not_recorded';

export interface IdentityPanelData {
  readonly level: { readonly id: string; readonly label: string };
  readonly code: {
    readonly state: CodeState;
    readonly channel: 'email';
    readonly confirmedAt: string | null;
    readonly attempts: number;
    readonly wrongAttempts: number;
    readonly codesSent: number;
  };
  readonly cvFollowUps: {
    readonly items: ReadonlyArray<{ cvDetail: string; question: string; asked: boolean; answer: string | null }>;
  };
}

export const IDENTITY_PANEL_TITLE = 'Identity & integrity';

export const IDENTITY_PANEL_NOTE = 'These are observations to help your review, not a decision. Nothing here changes the assessment, and no candidate is turned down because of it: a person decides.';

export const OTHER_SIGNALS_NOTE = 'No other identity signals are collected at this level. Any that are switched on later will appear here.';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function codeSummary(code: IdentityPanelData['code']): { title: string; detail: string } {
  switch (code.state) {
    case 'confirmed': {
      const entries = code.wrongAttempts === 0
        ? 'Entered correctly the first time.'
        : `${plural(code.wrongAttempts, 'incorrect entry', 'incorrect entries')} before the correct one.`;
      const sends = code.codesSent > 1 ? ` ${plural(code.codesSent, 'code was', 'codes were')} sent.` : '';
      return { title: 'Code confirmed by email', detail: `Confirmed ${formatDateTime(code.confirmedAt)}. ${entries}${sends}` };
    }
    case 'not_confirmed':
      return {
        title: 'Code not confirmed',
        detail: code.codesSent === 0
          ? 'A code applied to this interview, but none was sent.'
          : `${plural(code.codesSent, 'code was', 'codes were')} sent and not confirmed.`,
      };
    case 'not_run':
      return { title: 'No code was sent', detail: 'This deployment does not deliver email, so the code check could not run.' };
    case 'not_run_demo':
      return { title: 'No code was sent', detail: 'In the demo, email goes only to you, so no code was sent to this candidate.' };
    case 'not_recorded':
      return { title: 'No code was asked for', detail: 'This interview was agreed to before identity checks were introduced.' };
  }
}

export function cvAnswerText(item: IdentityPanelData['cvFollowUps']['items'][number]): string {
  if (!item.asked) return 'Not reached in the interview.';
  return item.answer ?? 'No answer recorded.';
}

export function cvFollowUpsEmpty(data: IdentityPanelData): string | null {
  return data.cvFollowUps.items.length === 0
    ? 'No CV details were available to ask about, so no CV questions were planned.'
    : null;
}
