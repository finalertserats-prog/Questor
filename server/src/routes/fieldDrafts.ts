import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { hasCapability } from '../services/access.js';
import { logAudit } from '../services/audit.js';
import { DRAFT_FIELD_KEYS, fieldDraftSpec, type DraftFieldKey } from '../domain/fieldDrafts.js';
import {
  MAX_CONTEXT_CHARS, suggestFieldDraft, tidyFieldText, DraftNotAllowedError,
} from '../services/fieldDrafts.js';

/**
 * Drafted text for the fields that are allowed to have it.
 *
 * Three routes, one boundary. `/suggest` writes into an empty authoring field.
 * `/tidy` rewrites what the person already typed and is allowed on fields a
 * fresh draft is not, because it cannot originate a judgement. `/accepted`
 * records that a draft was taken, so an organisation can see which of its
 * text was AI-assisted.
 *
 * The verdict reason, evidence notes and level-override reasons reach
 * `/suggest` only as a 422: the refusal is in the domain (domain/fieldDrafts.ts)
 * and is re-stated here so a request that bypasses the browser is refused too.
 * It is deliberately not a 400 — the caller's request is well formed, it is
 * the act that is not allowed.
 */

export const fieldDraftsRouter = Router();
fieldDraftsRouter.use(authenticate);

const fieldSchema = z.enum(DRAFT_FIELD_KEYS as unknown as [DraftFieldKey, ...DraftFieldKey[]]);

const suggestSchema = z.object({
  field: fieldSchema,
  context: z.string().max(MAX_CONTEXT_CHARS).default(''),
}).strict();

const tidySchema = z.object({
  field: fieldSchema,
  text: z.string().max(MAX_CONTEXT_CHARS),
}).strict();

const acceptedSchema = z.object({
  field: fieldSchema,
  source: z.enum(['suggestion', 'tidy']),
  entityType: z.string().max(60).default(''),
  entityId: z.string().max(200).default(''),
}).strict();

/**
 * The capability the field itself asks for. Checked per field rather than once
 * for the router: writing a job advert and tidying a reviewer's own words are
 * different jobs held by different people.
 */
function assertMayDraft(auth: Parameters<typeof hasCapability>[0], field: DraftFieldKey): void {
  const spec = fieldDraftSpec(field);
  if (!hasCapability(auth, spec.capability)) {
    throw new HttpError(403, `You do not have the permission needed to draft "${spec.label}".`);
  }
}

fieldDraftsRouter.post('/suggest', asyncHandler(async (req, res) => {
  const body = suggestSchema.parse(req.body);
  assertMayDraft(req.auth!, body.field);
  try {
    const drafted = await suggestFieldDraft({ tenantId: req.auth!.tenantId, field: body.field, context: body.context });
    res.json(drafted);
  } catch (err: unknown) {
    if (err instanceof DraftNotAllowedError) {
      throw new HttpError(422, fieldDraftSpec(body.field).refusal);
    }
    throw err;
  }
}));

fieldDraftsRouter.post('/tidy', asyncHandler(async (req, res) => {
  const body = tidySchema.parse(req.body);
  assertMayDraft(req.auth!, body.field);
  try {
    res.json(await tidyFieldText({ tenantId: req.auth!.tenantId, field: body.field, text: body.text }));
  } catch (err: unknown) {
    if (err instanceof DraftNotAllowedError) {
      throw new HttpError(422, 'This text cannot be tidied.');
    }
    throw err;
  }
}));

/**
 * A draft was taken. Audited rather than silent: an organisation that allows
 * AI-drafted text is entitled to know which of its role content and its
 * messages came from a draft, and a reviewer who tidied their own words should
 * be able to show that the substance was theirs.
 */
fieldDraftsRouter.post('/accepted', asyncHandler(async (req, res) => {
  const body = acceptedSchema.parse(req.body);
  assertMayDraft(req.auth!, body.field);
  // A record saying "a suggestion was accepted for the verdict reason" would
  // be a record of something that cannot happen — and an audit trail that can
  // be made to assert the boundary was crossed is worse than none. The pair
  // is checked against the same spec the suggest route refuses on.
  const spec = fieldDraftSpec(body.field);
  if (body.source === 'suggestion' && !spec.suggest) throw new HttpError(422, spec.refusal);
  if (body.source === 'tidy' && !spec.tidy) throw new HttpError(422, 'This text cannot be tidied.');
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'draft.accepted',
    entityType: body.entityType || 'FieldDraft', entityId: body.entityId,
    after: { field: body.field, source: body.source },
  });
  res.status(201).json({ recorded: true });
}));
