import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdentityIntegrityView } from '../src/components/IdentityIntegrityPanel';
import { IdentityCodeForm } from '../src/components/IdentityCodeStep';
import { IdentityAssuranceForm } from '../src/components/IdentityAssuranceSetting';
import { canSaveLevel, optionLabel, type AssuranceSettingData } from '../src/components/identityAssuranceModel';
import { codeSummary, cvAnswerText, type IdentityPanelData } from '../src/components/identityPanelModel';

const noop = () => undefined;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

function panel(over: Partial<IdentityPanelData> = {}): IdentityPanelData {
  return {
    level: { id: 'standard', label: 'Standard' },
    code: { state: 'confirmed', channel: 'email', confirmedAt: '2026-09-22T09:00:00Z', attempts: 2, wrongAttempts: 1, codesSent: 1 },
    cvFollowUps: {
      items: [
        { cvDetail: 'Led migration from Redshift to Snowflake.', question: 'Walk me through the migration.', asked: true, answer: 'We ran both side by side for six weeks.' },
        { cvDetail: 'Built streaming pipelines with Kafka.', question: 'What problem did you hit?', asked: false, answer: null },
      ],
    },
    ...over,
  };
}

describe('the code line of the identity panel', () => {
  it('says the code was confirmed by email', () => {
    expect(codeSummary(panel().code).title).toBe('Code confirmed by email');
  });

  it('counts the incorrect entries before the right one', () => {
    expect(codeSummary(panel().code).detail).toContain('1 incorrect entry before the correct one.');
  });

  it('says so plainly when the code was entered first time', () => {
    expect(codeSummary({ ...panel().code, attempts: 1, wrongAttempts: 0 }).detail).toContain('Entered correctly the first time.');
  });

  it('explains a check that could not run without blaming the candidate', () => {
    expect(codeSummary({ ...panel().code, state: 'not_run' }).detail).toBe('This deployment does not deliver email, so the code check could not run.');
  });

  it('explains why a demo candidate was sent no code', () => {
    expect(codeSummary({ ...panel().code, state: 'not_run_demo' }).detail).toMatch(/In the demo, email goes only to you/);
  });

  it('explains an interview from before the checks existed', () => {
    expect(codeSummary({ ...panel().code, state: 'not_recorded' }).title).toBe('No code was asked for');
  });
});

describe('the CV questions', () => {
  it('shows the answer given', () => {
    expect(cvAnswerText(panel().cvFollowUps.items[0])).toBe('We ran both side by side for six weeks.');
  });

  it('marks a question the interview did not reach', () => {
    expect(cvAnswerText(panel().cvFollowUps.items[1])).toBe('Not reached in the interview.');
  });
});

describe('the identity & integrity panel', () => {
  it('carries no heading of its own: the fold that holds it supplies one', () => {
    expect(html(createElement(IdentityIntegrityView, { data: panel() }))).not.toContain('<h2');
  });

  it('shows each CV question with the CV line it came from', () => {
    const out = html(createElement(IdentityIntegrityView, { data: panel() }));
    expect([out.includes('Led migration from Redshift to Snowflake.'), out.includes('Walk me through the migration.')]).toEqual([true, true]);
  });

  it('has no buttons at all: nothing here rejects or decides', () => {
    expect(html(createElement(IdentityIntegrityView, { data: panel() }))).not.toMatch(/<button|reject/i);
  });

  it('says a person decides', () => {
    expect(html(createElement(IdentityIntegrityView, { data: panel() }))).toContain('a person decides');
  });

  it('leaves room for later signals', () => {
    expect(html(createElement(IdentityIntegrityView, { data: panel() }))).toContain('Other signals');
  });
});

describe('the code step the candidate sees', () => {
  const form = (over: Partial<Parameters<typeof IdentityCodeForm>[0]> = {}) => html(createElement(IdentityCodeForm, {
    destination: 'p••••@example.com', sent: true, code: '', busy: false, secondsLeft: 0, error: '',
    onCode: noop, onSubmit: noop, onResend: noop, ...over,
  }));

  it('says why the code is asked for before asking for it', () => {
    expect(form()).toContain('confirms that the person taking the interview is the person who applied');
  });

  it('lets a phone fill the code from the message', () => {
    expect(form()).toContain('autoComplete="one-time-code"');
  });

  it('holds the resend button until the countdown ends', () => {
    expect(form({ secondsLeft: 30 })).toMatch(/<button[^>]*disabled=""[^>]*>Resend code in 30s/);
  });

  it('offers help when the email does not arrive', () => {
    expect(form()).toContain('Didn&#x27;t get the email?');
  });
});

describe('the assurance level setting', () => {
  const data: AssuranceSettingData = {
    level: 'standard',
    levels: [
      { id: 'standard', label: 'Standard', description: 'Code and CV questions.', available: true },
      { id: 'enhanced', label: 'Enhanced', description: 'Start photo.', available: false },
      { id: 'verified', label: 'Verified', description: 'ID check.', available: false },
    ],
  };

  it('marks the levels not built yet as coming later', () => {
    expect(optionLabel(data.levels[2], 'standard')).toBe('Verified (coming later)');
  });

  it('marks the current level', () => {
    expect(optionLabel(data.levels[0], 'standard')).toBe('Standard (current)');
  });

  it('will not save a level that is not available', () => {
    expect(canSaveLevel(data, 'verified')).toBe(false);
  });

  it('shows the unavailable levels as disabled choices', () => {
    const out = html(createElement(IdentityAssuranceForm, { data, choice: 'standard', saving: false, onChoose: noop, onSave: noop }));
    expect(out.match(/type="radio"[^>]*disabled=""/g)?.length).toBe(2);
  });

  it('offers no Save while there is nothing else to choose', () => {
    const out = html(createElement(IdentityAssuranceForm, { data, choice: 'standard', saving: false, onChoose: noop, onSave: noop }));
    expect(out).not.toContain('<button');
  });
});
