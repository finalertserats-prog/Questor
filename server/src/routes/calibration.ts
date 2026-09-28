// The calibration admin surface, and a reviewer's own figures.
//
// Two audiences, two gates:
//
//   * The organisation's admin (`admin:manage`) sees what the model has
//     learned, what is applied, what is held and why, the anchor proposals,
//     and the reviewer patterns. Every read of another person's pattern data
//     is audited, because it is employee data.
//   * Every authenticated reviewer sees THEIR OWN figures — the same numbers,
//     not a softened version — with no capability required. Where employee
//     data is processed that is a transparency obligation, not a courtesy.

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, HttpError, requireCapability } from '../middleware/index.js';
import {
  adjustmentsFor, CalibrationNotFound, restoreCalibration, revertCalibration, runCalibration,
} from '../services/calibrationActivation.js';
import {
  anchorProposalsFor, AnchorProposalNotFound, decideAnchorProposal,
} from '../services/calibrationAnchors.js';
import { contributeGlobalObservations } from '../services/calibrationGlobal.js';
import {
  calibrationSettingsFor, GLOBAL_CONTRIBUTION_CONSENT,
} from '../services/calibrationSettings.js';
import {
  auditPatternView, decidePatternAlert, ownPatternFor, PatternAlertNotFound, patternReport, refreshPatternAlerts,
  PATTERN_NOTICE,
} from '../services/reviewerPatterns.js';

export const calibrationRouter = Router();

calibrationRouter.use(authenticate);

const MAX_REASON = 2000;
const reasonSchema = z.object({ reason: z.string().trim().min(10).max(MAX_REASON) }).strict();

/** Everything the admin calibration view renders. */
calibrationRouter.get('/', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const [settings, adjustments, proposals] = await Promise.all([
    calibrationSettingsFor(tenantId),
    adjustmentsFor(tenantId),
    anchorProposalsFor(tenantId),
  ]);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    settings: {
      enabled: settings.enabled,
      platformEnabled: settings.platformEnabled,
      organisationEnabled: settings.organisationEnabled,
      contributesGlobally: settings.contributesGlobally,
      thresholds: settings.thresholds,
    },
    consentText: GLOBAL_CONTRIBUTION_CONSENT,
    adjustments,
    proposals,
  });
}));

/**
 * Recompute now. The automatic job does this on its own schedule; this exists
 * so an admin who has just changed a setting can see the effect rather than
 * wonder whether anything happened.
 */
calibrationRouter.post('/run', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const result = await runCalibration(req.auth!.tenantId);
  res.json(result);
}));

calibrationRouter.post('/contribute', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const contributed = await contributeGlobalObservations(req.auth!.tenantId);
  res.json({ contributed });
}));

/** Switch one calibration off. One action, audited, effective from the next interview. */
calibrationRouter.post('/:id/revert', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const body = reasonSchema.parse(req.body ?? {});
  try {
    await revertCalibration({
      tenantId: req.auth!.tenantId, adjustmentId: req.params.id!, actorId: req.auth!.userId, reason: body.reason,
    });
  } catch (err) {
    if (err instanceof CalibrationNotFound) throw new HttpError(404, err.message);
    throw err;
  }
  res.json({ reverted: true });
}));

calibrationRouter.post('/:id/restore', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  try {
    await restoreCalibration({ tenantId: req.auth!.tenantId, adjustmentId: req.params.id!, actorId: req.auth!.userId });
  } catch (err) {
    if (err instanceof CalibrationNotFound) throw new HttpError(404, err.message);
    throw err;
  }
  res.json({ restored: true });
}));

const anchorDecisionSchema = z.object({
  decision: z.enum(['applied', 'declined']),
  reason: z.string().trim().max(MAX_REASON).default(''),
}).strict();

calibrationRouter.post('/anchors/:id', requireCapability('role:approve_scorecard'), asyncHandler(async (req, res) => {
  const body = anchorDecisionSchema.parse(req.body ?? {});
  try {
    await decideAnchorProposal({
      tenantId: req.auth!.tenantId, proposalId: req.params.id!, decision: body.decision,
      actorId: req.auth!.userId, reason: body.reason,
    });
  } catch (err) {
    if (err instanceof AnchorProposalNotFound) throw new HttpError(404, err.message);
    throw err;
  }
  res.json({ decided: body.decision });
}));

// ---------------------------------------------------------------------------
// Reviewer patterns
// ---------------------------------------------------------------------------

/**
 * Every reviewer's figures. Admin only, and the read itself is audited: this is
 * employee data, and who looked at it is part of the record.
 */
calibrationRouter.get('/reviewers', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const report = await patternReport(tenantId);
  await auditPatternView({
    tenantId, actorId: req.auth!.userId, reviewerId: null, requestId: req.requestId,
  });
  res.set('Cache-Control', 'private, no-store');
  res.json(report);
}));

calibrationRouter.post('/reviewers/refresh', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const result = await refreshPatternAlerts(req.auth!.tenantId);
  res.json(result);
}));

/**
 * A reviewer's own figures.
 *
 * No capability: the subject of the data may always read it. The same numbers
 * the admin sees, and the notice saying what is kept and who can see it.
 * Deliberately declared BEFORE `/reviewers/:id`, so "me" is never read as an id.
 */
calibrationRouter.get('/reviewers/me', asyncHandler(async (req, res) => {
  const own = await ownPatternFor(req.auth!.tenantId, req.auth!.userId);
  res.set('Cache-Control', 'private, no-store');
  res.json({ notice: PATTERN_NOTICE, reviewer: own });
}));

calibrationRouter.post('/reviewers/alerts/:id', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const body = z.object({
    decision: z.enum(['acknowledged', 'dismissed']),
    note: z.string().trim().max(MAX_REASON).default(''),
  }).strict().parse(req.body ?? {});
  try {
    await decidePatternAlert({
      tenantId: req.auth!.tenantId, alertId: req.params.id!, decision: body.decision,
      actorId: req.auth!.userId, note: body.note,
    });
  } catch (err) {
    if (err instanceof PatternAlertNotFound) throw new HttpError(404, err.message);
    throw err;
  }
  res.json({ decided: body.decision });
}));

/** One reviewer's figures, for an admin looking at a specific person. Audited. */
calibrationRouter.get('/reviewers/:id', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const reviewerId = req.params.id!;
  const own = await ownPatternFor(tenantId, reviewerId);
  if (!own) throw new HttpError(404, 'That reviewer has not completed any reviews in this window.');
  await auditPatternView({ tenantId, actorId: req.auth!.userId, reviewerId, requestId: req.requestId });
  res.set('Cache-Control', 'private, no-store');
  res.json({ notice: PATTERN_NOTICE, reviewer: own });
}));
