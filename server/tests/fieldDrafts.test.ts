import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { _setLlmForTests } from '../src/providers/llm/index.js';
import type { LlmMessage, LlmProvider } from '../src/providers/llm/types.js';
import { fieldDraftSpec, shapeDraft, suggestibleFields, DRAFT_FIELD_KEYS } from '../src/domain/fieldDrafts.js';

/**
 * AI-drafted suggestions, and the boundary around them.
 *
 * The boundary is the point of the feature: authoring fields may be drafted,
 * the fields that hold a person's judgement may not. It is tested at the
 * domain AND at the route, because a check that only exists in the browser is
 * not a boundary.
 */

const app = createApp();

/** The reply every draft call is answered with unless a test says otherwise. */
let scripted: { text: string; confident: boolean } = {
  text: 'A senior engineer on the payments platform, owning the services that move money end to end.',
  confident: true,
};
let calls: LlmMessage[][] = [];

class ScriptedProvider implements LlmProvider {
  name = 'scripted';
  enabled = true;
  async generate(messages: LlmMessage[]) {
    calls.push(messages);
    return { text: JSON.stringify(scripted), model: 'scripted-1', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}

let managerToken = '';
let recruiterToken = '';
let tenantId = '';

beforeAll(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Drafting Org' } });
  tenantId = tenant.id;
  const manager = await prisma.user.create({
    data: { tenantId, email: 'manager@drafts.local', name: 'Rahul Verma', passwordHash: 'x', role: 'manager' },
  });
  const recruiter = await prisma.user.create({
    data: { tenantId, email: 'recruiter@drafts.local', name: 'Priya Rao', passwordHash: 'x', role: 'recruiter' },
  });
  managerToken = signToken({ userId: manager.id, tenantId, role: 'manager', email: manager.email });
  recruiterToken = signToken({ userId: recruiter.id, tenantId, role: 'recruiter', email: recruiter.email });
  _setLlmForTests(new ScriptedProvider());
});

afterAll(() => { _setLlmForTests(null); });

beforeEach(async () => {
  calls = [];
  scripted = { text: 'A senior engineer on the payments platform, owning the services that move money end to end.', confident: true };
  await prisma.tenant.update({ where: { id: tenantId }, data: { policyJson: '{}' } });
});

const suggest = (token: string, body: unknown) =>
  request(app).post('/api/drafts/suggest').set('Authorization', `Bearer ${token}`).send(body);
const tidy = (token: string, body: unknown) =>
  request(app).post('/api/drafts/tidy').set('Authorization', `Bearer ${token}`).send(body);

describe('the drafting boundary', () => {
  it('offers a draft for role content', async () => {
    const res = await suggest(recruiterToken, { field: 'role_summary', context: 'Senior Backend Engineer, payments' });
    expect(res.status).toBe(200);
    expect(res.body.text).toContain('payments platform');
  });

  it('refuses to draft the reviewer\'s verdict reason', async () => {
    const res = await suggest(managerToken, { field: 'verdict_reason', context: 'Arjun Mehta' });
    expect(res.status).toBe(422);
    expect(calls).toEqual([]);
  });

  it('refuses to draft an evidence note or a level-override reason', async () => {
    expect((await suggest(managerToken, { field: 'evidence_note', context: '' })).status).toBe(422);
    expect((await suggest(managerToken, { field: 'level_override_reason', context: '' })).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it('refuses to draft a round note, which is a human\'s own observation', async () => {
    expect((await suggest(recruiterToken, { field: 'round_note', context: '' })).status).toBe(422);
  });

  it('names no judgement field as suggestible', () => {
    expect(suggestibleFields()).not.toContain('verdict_reason');
    expect(suggestibleFields()).not.toContain('evidence_note');
    expect(suggestibleFields()).not.toContain('level_override_reason');
    expect(suggestibleFields()).not.toContain('round_note');
  });

  it('gives every judgement field a refusal sentence to show the person', () => {
    const judgement = DRAFT_FIELD_KEYS.filter((key) => !fieldDraftSpec(key).suggest);
    expect(judgement.length).toBeGreaterThan(0);
    for (const key of judgement) expect(fieldDraftSpec(key).refusal.length).toBeGreaterThan(20);
  });
});

describe('tidying what the person wrote', () => {
  const THEIRS = 'he cant do mornings ist before 11, wants the systems round w/ someone from payments';

  it('tidies the reviewer\'s own verdict reason, which no draft may be offered for', async () => {
    scripted = { text: 'He is not available before 11:00 IST and would like the systems round with someone from Payments.', confident: true };
    const res = await tidy(managerToken, { field: 'verdict_reason', text: THEIRS });
    expect(res.status).toBe(200);
    expect(res.body.text).toContain('11:00 IST');
  });

  it('has nothing to tidy before the person has written something', async () => {
    const res = await tidy(managerToken, { field: 'verdict_reason', text: 'too short' });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('');
    expect(calls).toEqual([]);
  });
});

describe('when there is nothing good to show', () => {
  it('shows nothing rather than an unconfident draft', async () => {
    scripted = { text: 'Something generic about a role.', confident: false };
    const res = await suggest(recruiterToken, { field: 'role_summary', context: 'x' });
    expect(res.body.text).toBe('');
  });

  it('shows nothing when the model answers with something unusable', async () => {
    scripted = { text: 'No.', confident: true };
    const res = await suggest(recruiterToken, { field: 'role_summary', context: 'x' });
    expect(res.body.text).toBe('');
  });
});

describe('the organisation\'s switch', () => {
  it('turns every draft off when the organisation forbids AI-generated text', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { policyJson: JSON.stringify({ aiFieldDrafts: false }) } });
    const drafted = await suggest(recruiterToken, { field: 'role_summary', context: 'Senior Backend Engineer' });
    expect(drafted.body).toEqual({ text: '', disabled: true });
    const tidied = await tidy(managerToken, { field: 'verdict_reason', text: 'a reason long enough to be tidied up properly' });
    expect(tidied.body).toEqual({ text: '', disabled: true });
    expect(calls).toEqual([]);
  });

  it('is on when the organisation has said nothing', async () => {
    const res = await suggest(recruiterToken, { field: 'role_summary', context: 'Senior Backend Engineer' });
    expect(res.body.disabled).toBe(false);
  });
});

describe('an accepted draft', () => {
  it('is recorded against the person who took it', async () => {
    const res = await request(app).post('/api/drafts/accepted')
      .set('Authorization', `Bearer ${recruiterToken}`)
      .send({ field: 'role_summary', source: 'suggestion', entityType: 'Role', entityId: 'role-1' });
    expect(res.status).toBe(201);
    const event = await prisma.auditEvent.findFirst({ where: { action: 'draft.accepted' }, orderBy: { createdAt: 'desc' } });
    expect(event?.afterJson).toContain('role_summary');
  });

  it('cannot be recorded as a suggestion for a field no suggestion may be offered for', async () => {
    const res = await request(app).post('/api/drafts/accepted')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ field: 'verdict_reason', source: 'suggestion' });
    expect(res.status).toBe(422);
    const events = await prisma.auditEvent.count({ where: { action: 'draft.accepted', afterJson: { contains: 'verdict_reason' } } });
    expect(events).toBe(0);
  });

  it('is recorded for a tidy of the reviewer\'s own words, which is allowed there', async () => {
    const res = await request(app).post('/api/drafts/accepted')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ field: 'verdict_reason', source: 'tidy' });
    expect(res.status).toBe(201);
  });
});

describe('permission', () => {
  it('refuses a draft to someone without the capability the field asks for', async () => {
    // A recruiter cannot review, so they cannot tidy a reviewer's words.
    const res = await tidy(recruiterToken, { field: 'verdict_reason', text: 'a reason long enough to be tidied up properly' });
    expect(res.status).toBe(403);
  });
});

describe('shaping what the model returned', () => {
  const spec = fieldDraftSpec('role_summary');

  it('drops code fences and surrounding quotes', () => {
    expect(shapeDraft('```\n"A tidy sentence about the role."\n```', spec)).toBe('A tidy sentence about the role.');
  });

  it('cuts an over-long draft at a boundary rather than mid-word', () => {
    const long = `${'Sentence about the role. '.repeat(200)}`;
    const cut = shapeDraft(long, spec);
    expect(cut.length).toBeLessThanOrEqual(spec.maxChars);
    expect(cut.endsWith('.')).toBe(true);
  });

  it('returns nothing for anything that is not a string', () => {
    expect(shapeDraft(null, spec)).toBe('');
    expect(shapeDraft(42, spec)).toBe('');
  });
});
