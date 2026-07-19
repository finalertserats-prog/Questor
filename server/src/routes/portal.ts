import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import {
  sttCapability,
  ttsCapability,
  serverTtsReady,
  synthesizeServerSpeech,
  speechEtag,
  serverSttReady,
  transcribeServerSpeech,
  isTranscribableMimeType,
  audioBytesMatchMimeType,
} from '../providers/speech.js';
import { logger } from '../logger.js';
import { startInterview, submitCandidateTurn, finalizeInterview, INVITATION_CONSUMED } from '../realtime/interviewEngine.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';

// Public candidate portal (BRD FR-043). No login — gated by invitation token.
export const portalRouter = Router();

const MAX_TURN_TEXT_CHARS = 4000;

// Far tighter than the answer ceiling because this one is billed per character
// of *output audio*. A spoken interview question is one or two sentences; 1200
// characters is roughly 90 seconds of speech and already generous.
const MAX_SPEAK_TEXT_CHARS = 1200;

// One spoken answer, not a recording of the whole session. Opus in a WebM
// container runs ~24-32 kbps, so 10 MB is already tens of minutes of speech —
// far past any single answer, and the bound that stops one upload turning into
// an unbounded per-minute bill. The buffer also lives in process memory, which
// is a second reason not to raise it.
const MAX_TRANSCRIBE_BYTES = 10 * 1024 * 1024;

// Only the states in which a candidate is genuinely mid-answer. Mirrors
// LIVE_STATES in interviewEngine; a finished, cancelled or not-yet-started
// interview has nothing to transcribe, and paying to transcribe audio for one
// would be spending on a session no reviewer will ever read.
const TRANSCRIBABLE_STATES = ['ASSESSING', 'CANDIDATE_QUESTIONS'];

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSCRIBE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // First gate only — the declared type is uploader-chosen, so the bytes are
    // sniffed in the handler before anything reaches the vendor.
    if (!isTranscribableMimeType(file.mimetype)) {
      cb(new HttpError(400, 'Only audio uploads (webm, ogg, mp4, m4a, mp3, wav) are accepted'));
      return;
    }
    cb(null, true);
  },
});

// Multer rejections (size cap, file count) are not HttpErrors, so without this
// a rejected upload would be reported to the client as a 500.
function receiveAudio(req: Request, res: Response, next: NextFunction): void {
  uploadAudio.single('audio')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      next(new HttpError(400, `Upload rejected: ${err.code === 'LIMIT_FILE_SIZE' ? 'audio exceeds the 10 MB limit' : 'only a single audio clip is accepted'}`));
      return;
    }
    next(err);
  });
}

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

  // Record the first open. SMTP acceptance only proves a provider took the
  // message — this is the first evidence a human actually received it, and it
  // is what lets a recruiter tell "they haven't got round to it" apart from
  // "it went to spam and they never saw it". Recorded once so a candidate
  // revisiting the page does not overwrite when they first saw it.
  if (!inv.openedAt) {
    await prisma.invitation.update({
      where: { id: inv.id },
      data: { openedAt: new Date(), status: inv.status === 'sent' ? 'opened' : inv.status },
    });
  }

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

const speakSchema = z.object({
  turnId: z.string().min(1).max(64).optional(),
  text: z.string().min(1).max(MAX_SPEAK_TEXT_CHARS).optional(),
}).refine((b) => b.turnId || b.text, { message: 'Provide turnId or text' });

/**
 * Server-side voice for the interviewer.
 *
 * This route is unauthenticated (the portal is gated only by an invitation
 * token) and every call spends money at a TTS vendor, so it is a standing
 * invitation to be used as a free TTS API. Four controls bound that:
 *
 *  1. A valid, unexpired, unconsumed invitation token — same gate as every
 *     other portal route that costs anything.
 *  2. A hard character cap, well below the vendor's own input limit.
 *  3. The text must correspond to an agent turn ALREADY PERSISTED for THIS
 *     session. This is the control that matters: the bytes sent to the vendor
 *     come from the database row, never from the request body, so arbitrary
 *     request text cannot be synthesized and there is no near-miss to exploit.
 *     Note this bounds spend to *interview* content, not strictly to
 *     server-authored content: agent turns are LLM output generated from
 *     candidate answers, and interviewEngine only flags prompt injection rather
 *     than blocking it, so a successful injection could in principle launder a
 *     short attacker string into a speakable turn. That path is rate-limited,
 *     length-capped and costs an LLM call per attempt, so it is a poor TTS
 *     oracle — but it is not zero, and blocking injection-flagged turns here
 *     would be the way to close it.
 *  4. A rate limit in app.ts, keyed on the invitation token like its siblings.
 *
 * When no server TTS is configured it answers 204 rather than an error, so the
 * client simply keeps using browser speechSynthesis. The zero-key build must
 * stay fully functional.
 */
portalRouter.post('/:token/speak', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  const body = speakSchema.parse(req.body);

  // Resolve to a real agent turn in THIS session. `text` is only ever used as a
  // lookup key — what gets synthesized is the stored row.
  //
  // Deliberately validated BEFORE the provider check, so a caller gets the same
  // answer to "is this a legitimate request" whether or not server TTS happens
  // to be switched on. Ordering it the other way would make the 204 fallback
  // mask a rejected request, and would leave the spend control untested in any
  // environment without a key.
  const turn = body.turnId
    ? await prisma.turn.findFirst({ where: { id: body.turnId, sessionId: inv.sessionId, speaker: 'agent' } })
    : await prisma.turn.findFirst({ where: { sessionId: inv.sessionId, speaker: 'agent', text: body.text }, orderBy: { index: 'desc' } });

  if (!turn) {
    // Same message for "no such turn" and "turn belongs to another session":
    // the difference would confirm whether a given string was said in some
    // other candidate's interview.
    throw new HttpError(404, 'No matching interviewer turn for this session');
  }

  // A stored turn longer than the cap is legitimate content, not an attack, so
  // fall back to browser speech rather than failing the interview over it.
  if (turn.text.length > MAX_SPEAK_TEXT_CHARS) {
    logger.warn({ sessionId: inv.sessionId, turnId: turn.id, chars: turn.text.length }, 'Agent turn exceeds TTS cap; falling back to browser speech');
    return res.status(204).end();
  }

  // Nothing configured to speak with: tell the client to use browser speech.
  if (!serverTtsReady()) return res.status(204).end();

  // Answer conditional requests BEFORE synthesizing. The ETag is a pure
  // function of (provider, model, voice, text), so it can be computed without
  // calling the vendor — checking it afterwards would save bandwidth but still
  // pay for the audio, which defeats the point.
  const etag = speechEtag(turn.text);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  let speech: Awaited<ReturnType<typeof synthesizeServerSpeech>>;
  try {
    speech = await synthesizeServerSpeech(turn.text);
  } catch (err) {
    // A vendor outage must not stop an interview mid-question. Log it and let
    // the client fall back to the browser voice.
    logger.error({ err: err instanceof Error ? err.message : String(err), sessionId: inv.sessionId }, 'Server TTS failed; falling back to browser speech');
    return res.status(204).end();
  }
  if (!speech) return res.status(204).end();

  res.setHeader('Content-Type', speech.contentType);
  res.setHeader('Content-Length', String(speech.audio.byteLength));
  return res.send(speech.audio);
}));

/**
 * Server-side transcription of a candidate's spoken answer.
 *
 * Exists because the browser path does not actually work everywhere. Chrome and
 * Edge implement SpeechRecognition by streaming microphone audio to a Google
 * speech backend; on a corporate network that blocks it the candidate gets
 * `Speech error: network` and voice input dies outright, forcing them to type an
 * answer they were told they could speak. That transfer is also a data-protection
 * problem in its own right — candidate audio reaching a third party the employer
 * never contracted with is exactly the kind of processing an interview consent
 * flow is supposed to enumerate. Transcribing here keeps the audio between the
 * candidate and the operator's chosen vendor.
 *
 * This is the most expensive unauthenticated route in the app: it is billed per
 * MINUTE OF AUDIO, and unlike /speak there is no server-authored artefact to
 * check the payload against — the bytes are inherently attacker-supplied, so
 * "only transcribe what we wrote" has no analogue here. The controls are
 * therefore all about bounding volume and shape:
 *
 *  1. A valid, unexpired, unconsumed invitation token — same gate as /speak.
 *  2. The session must be mid-interview. A finished interview cannot produce a
 *     new answer, so a request against one is either a bug or an abuser.
 *  3. A hard 10 MB cap, enforced by multer before the body is buffered.
 *  4. A mime allowlist AND a magic-byte check, so a non-audio payload cannot be
 *     laundered through a forged Content-Type into a paid vendor call.
 *  5. The strictest rate limit in app.ts, keyed on the invitation token.
 *
 * When no server STT is configured it answers 204, so the client keeps using
 * browser SpeechRecognition and the zero-key build stays fully functional.
 */
portalRouter.post('/:token/transcribe', receiveAudio, asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });

  // Every check below is deliberately ordered BEFORE the provider check, so a
  // caller gets the same verdict on "is this a legitimate request" whether or
  // not server STT happens to be switched on. Ordering it the other way would
  // let the 204 fallback mask a rejected request, and would leave every spend
  // control untested in any environment without a key.
  if (!TRANSCRIBABLE_STATES.includes(inv.session.state)) {
    throw new HttpError(409, 'This interview is not currently accepting answers.');
  }

  const file = req.file;
  if (!file) throw new HttpError(400, 'No audio uploaded');
  if (!file.buffer.length) throw new HttpError(400, 'Uploaded audio is empty');

  // The fileFilter trusted the declared type; this does not. A payload whose
  // bytes disagree with its Content-Type is never forwarded to a paid vendor.
  if (!audioBytesMatchMimeType(file.buffer, file.mimetype)) {
    throw new HttpError(400, 'The uploaded audio does not match its declared file type.');
  }

  // Nothing configured to transcribe with: tell the client to use browser
  // SpeechRecognition.
  if (!serverSttReady()) return res.status(204).end();

  let text: string | null;
  try {
    text = await transcribeServerSpeech(file.buffer, file.mimetype);
  } catch (err) {
    // A vendor outage must not strand a candidate mid-answer. Log it and let
    // the client fall back to browser speech, exactly as /speak does.
    logger.error({ err: err instanceof Error ? err.message : String(err), sessionId: inv.sessionId }, 'Server STT failed; falling back to browser speech');
    return res.status(204).end();
  }
  if (text === null) return res.status(204).end();

  // Audio is never persisted here. The transcript is the record the interview
  // actually uses, and keeping the raw voice clip would add a biometric-adjacent
  // artefact with its own retention and consent obligations for no benefit.
  return res.json({ text });
}));
