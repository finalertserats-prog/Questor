import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { sttCapability, ttsCapability } from '../providers/speech.js';
import { startInterview, submitCandidateTurn, finalizeInterview, INVITATION_CONSUMED } from '../realtime/interviewEngine.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';

// Public candidate portal (BRD FR-043). No login — gated by invitation token.
export const portalRouter = Router();

const MAX_TURN_TEXT_CHARS = 4000;

/**
 * `requireUnconsumed` gates the paths that advance or mutate the interview. Read-only
 * status views deliberately stay open after the interview finalises: a candidate
 * must always be able to see that their interview is complete, and locking them
 * out of that view reads as the link being broken.
 */
async function loadByToken(token: string, opts?: { requireUnconsumed?: boolean }) {
  const inv = await prisma.invitation.findUnique({ where: { token }, include: { session: { include: { candidate: true, role: true } } } });
  if (!inv) throw new HttpError(404, 'Invitation not found or expired');
  if (inv.expiresAt && inv.expiresAt < new Date()) throw new HttpError(410, 'This invitation has expired');
  if (opts?.requireUnconsumed && inv.status === INVITATION_CONSUMED) {
    throw new HttpError(410, 'This interview has already been completed. Our team will be in touch.');
  }
  return inv;
}

portalRouter.get('/:token', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token);
  const s = inv.session;
  const consent = parseJson<any>(s.consentJson, {});
  res.json({
    candidateName: s.candidate.fullName,
    roleTitle: s.role.title,
    state: s.state,
    durationMinutes: s.durationMinutes,
    language: s.language,
    aiDisclosure: consent.disclosureText,
    recordingRequested: !!consent.recordingRequested,
    privacy: 'Your responses are transcribed and reviewed by our hiring team. This first round is conducted by an AI interviewer. You may request accommodations or a human alternative, and you can withdraw consent at any time.',
    accommodationsEnabled: true,
    speech: { stt: sttCapability(), tts: ttsCapability() },
  });
}));

portalRouter.post('/:token/accept', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token);
  if (inv.session.state === 'INVITED') {
    await prisma.interviewSession.update({ where: { id: inv.sessionId }, data: { state: 'ACCEPTED' } });
    await prisma.invitation.update({ where: { id: inv.id }, data: { status: 'accepted', acceptedAt: new Date() } });
    await emitEvent(inv.session.tenantId, 'invitation.accepted', { sessionId: inv.sessionId });
    await logAudit({ tenantId: inv.session.tenantId, actorType: 'user', actorId: 'candidate', action: 'invitation.accepted', entityType: 'InterviewSession', entityId: inv.sessionId });
  }
  res.json({ ok: true, state: 'ACCEPTED' });
}));

const consentSchema = z.object({ recordingConsent: z.boolean(), accepted: z.boolean(), accommodationRequest: z.string().optional() });
portalRouter.post('/:token/consent', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token);
  const body = consentSchema.parse(req.body);
  if (!body.accepted) throw new HttpError(400, 'Consent to proceed is required, or choose the human-alternative path.');

  if (body.accommodationRequest?.trim()) {
    // BRD exception: stop standard flow, record minimally, hand off.
    await prisma.interviewSession.update({ where: { id: inv.sessionId }, data: { state: 'MANUAL_HANDOFF' } });
    await logAudit({ tenantId: inv.session.tenantId, actorType: 'user', actorId: 'candidate', action: 'accommodation.requested', entityType: 'InterviewSession', entityId: inv.sessionId });
    return res.json({ ok: true, handoff: true, message: 'Your accommodation request has been recorded and routed to our team. Someone will contact you.' });
  }

  const consent = parseJson<any>(inv.session.consentJson, {});
  consent.recording = body.recordingConsent;
  consent.consentVersion = 'v1';
  consent.consentedAt = new Date().toISOString();
  consent.channel = 'portal';
  await prisma.interviewSession.update({
    where: { id: inv.sessionId },
    data: { consentJson: JSON.stringify(consent), recordingConsent: body.recordingConsent },
  });
  await logAudit({ tenantId: inv.session.tenantId, actorType: 'user', actorId: 'candidate', action: 'consent.recorded', entityType: 'InterviewSession', entityId: inv.sessionId, after: { recording: body.recordingConsent } });
  res.json({ ok: true, recordingConsent: body.recordingConsent });
}));

portalRouter.post('/:token/techcheck', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token);
  const body = z.object({ mic: z.boolean(), speaker: z.boolean() }).parse(req.body);
  const quality = parseJson<any>(inv.session.qualityJson, {});
  quality.techCheck = { ...body, at: new Date().toISOString() };
  await prisma.interviewSession.update({ where: { id: inv.sessionId }, data: { qualityJson: JSON.stringify(quality) } });
  res.json({ ok: true, ready: body.mic && body.speaker });
}));

// Text-mode fallback endpoints (used when Web Speech is unavailable). The
// primary path is the Socket.IO room, but these keep the interview fully
// completable over plain HTTP.
portalRouter.post('/:token/start', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  const turn = await startInterview(inv.sessionId);
  res.json({ turn });
}));
portalRouter.post('/:token/turn', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  // Unauthenticated route where every call funds an LLM prompt. The 2mb Express
  // JSON limit is not a spend limit, so bound the answer here: a spoken reply
  // runs a few hundred characters, far under this ceiling.
  const { text, startMs, endMs } = z.object({ text: z.string().min(1).max(MAX_TURN_TEXT_CHARS), startMs: z.number().optional(), endMs: z.number().optional() }).parse(req.body);
  const turn = await submitCandidateTurn(inv.sessionId, text, { startMs, endMs });
  let assessmentReady = false;
  if (turn.done) { await finalizeInterview(inv.sessionId); assessmentReady = true; }
  res.json({ turn, assessmentReady });
}));
