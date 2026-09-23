import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
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
import {
  startOrResumeInterview, submitCandidateAnswer, continueAfterAnswer, finalizeInterview, withdrawInterview, endReasonFor,
  hasRecordedConsent, INVITATION_CONSUMED, type AgentTurnOut,
} from '../realtime/interviewEngine.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';
import { notifyHiringTeam } from '../services/hiringTeamNotice.js';
import { disclosureWithProctoringPolicy, proctoringEnabledForSession } from '../services/proctoringPolicy.js';
import { hasObserverNotice } from '../services/observerPolicy.js';
import { personaNameOf } from '../domain/persona.js';
import { ensureSessionInterviewer, interviewerIdOf, voiceForInterviewer, voiceHintForInterviewer } from '../services/interviewers.js';
import { findInvitationByToken } from '../services/invitations.js';
import { openingQuestion } from '../engines/openingModel.js';
import { hasConsentIntro } from '../domain/interviewerModel.js';
import { getDisclosureText, describeLanguageSupport } from '../i18n/locales.js';
import { feedbackOptInOffered, getOptIn, recordFeedbackOptIn, recordHumanRequestForSession } from '../services/candidateFeedback.js';
import { buildCandidateStatus, STATUS_SESSION_SELECT } from '../services/candidateStatus.js';
import { linkStillLeadsToInterview, statusOutcome } from '../domain/candidateStatusModel.js';
import { LETTER_HEADING, SIGN_OFF, TALK_LINK_PLACEHOLDER, TALK_PROMPT } from '../providers/email/autoFeedbackEmail.js';
import { serverSpeechAllowed } from '../services/demoPolicy.js';
import { formatScheduledTime } from '../services/zonedTime.js';
import { tenantTimeZone } from '../services/tenantTimeZone.js';
import { identityCheckForConsent, portalIdentityView, recordedIdentityCheck } from '../services/identityAssurance.js';
import { CODE_TTL_MS, issueIdentityCode, maskEmail, normalizeCode, verifyIdentityCode } from '../services/identityCode.js';

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
/**
 * Before the interview: the only states in which accepting, consenting or a
 * tech check make sense. A completed interview's link used to accept a consent
 * post and could be moved from REVIEW_READY, or even CLOSED, to MANUAL_HANDOFF
 * by anyone who still had the link.
 */
const PRE_INTERVIEW_STATES = ['PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'DISCLOSURE', 'CONSENTED'];
const FINISHED_MESSAGE = 'This interview has already started or finished, so this can no longer be changed.';
/** A day. Timings beyond it are not measurements of anything. */
const MAX_TURN_MS = 24 * 60 * 60 * 1000;
/** Shorter than this and a person cannot act on it; the candidate is told so. */
export const ACCOMMODATION_MIN_LENGTH = 10;
export const ACCOMMODATION_MAX_LENGTH = 2000;
const INTEGRITY_EVENT_TYPES = ['TAB_BLUR', 'FOCUS_LOST', 'PASTE_DETECTED', 'MULTI_TAB', 'DEVTOOLS_OPENED'] as const;
const INTEGRITY_EVENT_STATES = ['CONSENTED', 'WARMUP', 'ASSESSING', 'CANDIDATE_QUESTIONS', 'CLOSING', 'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED'];

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
async function loadByToken(token: string, opts?: { requireUnconsumed?: boolean; statusView?: boolean }) {
  // Shape-checked, hashed, compared in constant time; the plaintext is never
  // stored or queried. See services/invitations.ts.
  const inv = await findInvitationByToken(token, (tokenHash) =>
    prisma.invitation.findUnique({ where: { tokenHash }, include: { session: { include: { candidate: true, role: true } } } }));
  if (!inv) throw new HttpError(404, 'Invitation not found or expired');
  // `statusView` survives the invitation's own expiry, and only once the
  // interview has actually happened. The expiry exists to stop a stale link
  // STARTING an interview; a candidate coming back six weeks later to read
  // where they stand is the thing this page is for, and a 410 there reads as
  // the company having deleted them. An expired link whose interview never
  // happened still expires: there is nothing to look at, and the link is
  // genuinely spent.
  const expired = inv.expiresAt && inv.expiresAt < new Date();
  if (expired && !(opts?.statusView && interviewIsOver(inv.session))) {
    throw new HttpError(410, 'This invitation has expired');
  }
  if (opts?.requireUnconsumed && inv.status === INVITATION_CONSUMED) {
    throw new HttpError(410, 'This interview has already been completed. Our team will be in touch.');
  }
  return inv;
}

/** Past the point where this link could ever start or resume an interview. */
function interviewIsOver(session: { state: string; completedAt: Date | null }): boolean {
  return statusOutcome(session.state, session.completedAt) !== 'closed' || Boolean(session.completedAt);
}

/**
 * The status routes answer only about a link that has stopped being an
 * invitation. Asked earlier they would tell a candidate who has not interviewed
 * yet that their link "has done its job", and would let the talk-to-a-person
 * request be made from a surface that does not exist for them yet — the
 * accommodation field on the consent screen is the way to ask before an
 * interview, and it routes to a person differently.
 */
function requireInterviewOver(session: { state: string; completedAt: Date | null }): void {
  if (linkStillLeadsToInterview(session.state, session.completedAt)) {
    throw new HttpError(409, 'This interview has not finished yet.');
  }
}


/**
 * The candidate's own written feedback, once it has been sent to them.
 *
 * Two paths reach a candidate and both are answered here, because to the person
 * reading their status page the difference between them is invisible and the
 * words are theirs either way:
 *
 *   1. A reviewer approved a draft and pressed send (CandidateFeedbackDelivery).
 *   2. The automatic letter went out after the review window
 *      (CandidateFeedbackEmail) — the common case, on by default.
 *
 * `sentAt` is the gate in both. Nothing unsent is ever readable here: a draft,
 * a queued letter or one held for a person is not the candidate's yet, and
 * showing it would leak the hiring team's working copy and pre-empt their
 * decision about whether to send it at all.
 *
 * The stored words are returned as they are, and deliberately not filtered for
 * verdict vocabulary. That is not a gap in the rule that a candidate is never
 * shown a verdict — it is where the rule is actually enforced: these exact
 * words were EMAILED to this candidate, so they are already theirs, and the
 * place to stop a verdict reaching them is before the letter goes (the
 * guardrails in providers/email/autoFeedbackEmail.ts and the human approving
 * it in routes/assessments.ts). Rewriting a letter on its way back to the
 * person who received it would make the page disagree with their inbox, which
 * is worse than the thing it would be guarding against. Everything the status
 * page derives ITSELF is held to the rule in domain/candidateStatusModel.ts.
 */
portalRouter.get('/:token/feedback', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { statusView: true });
  const [assessment, auto] = await Promise.all([
    prisma.assessmentVersion.findFirst({
      where: { sessionId: inv.sessionId },
      orderBy: { createdAt: 'desc' },
      include: { candidateFeedback: true },
    }),
    prisma.candidateFeedbackEmail.findUnique({
      where: { sessionId: inv.sessionId },
      select: { status: true, sentAt: true, bodyText: true },
    }),
  ]);
  const feedback = assessment?.candidateFeedback;
  if (feedback && feedback.status === 'SENT' && feedback.approvedText && feedback.sentAt) {
    // A reviewer read this letter and released it: the page may say so.
    return res.json({ approvedText: feedback.approvedText, sentAt: feedback.sentAt, source: 'reviewer' });
  }
  if (auto && SENT_FEEDBACK_STATUSES.includes(auto.status) && auto.sentAt && auto.bodyText.trim()) {
    // The automatic letter goes 12 hours after the interview whether or not a
    // person has read it, so the page must not claim the team checked it.
    return res.json({ approvedText: readableLetter(auto.bodyText), sentAt: auto.sentAt, source: 'automatic' });
  }
  return res.status(404).json({ feedback: null });
}));

/** Both mean the words have left for the candidate. See autoFeedbackModel.ts. */
const SENT_FEEDBACK_STATUSES: readonly string[] = ['SENT', 'SENT_UNVERIFIED'];

/**
 * The stored letter, read as a page rather than as an email.
 *
 * Three things are dropped, and only three, because everything else is the
 * candidate's own feedback and none of it is ours to edit:
 *
 *   - The envelope at the top ("INTERVIEW FEEDBACK", their name, the role, the
 *     date). The status page says all of that above the letter already, and
 *     reading your own name and role twice in ten lines reads as a machine.
 *   - Everything from the sign-off down: the sign-off, who it is from, and the
 *     footer saying an AI drafted it. The page carries that last line itself,
 *     once, directly under the letter.
 *   - The talk-to-a-person prompt, and the bracketed note standing in for a
 *     link that is deliberately not stored (TALK_LINK_PLACEHOLDER). The page
 *     has its own button for that.
 *
 * Every cut is anchored on a marker exported by the template that wrote the
 * text. When a marker is not there — a human's own approved letter, or a
 * template that has since moved on — nothing is cut and the words are shown as
 * they are. Silently dropping the wrong half of somebody's feedback would be
 * far worse than showing a line of email furniture.
 */
function readableLetter(bodyText: string): string {
  let lines = bodyText.split('\n');

  const greeting = lines.findIndex((line) => /^(hi|hello|dear)\b/i.test(line.trim()));
  if (lines[0]?.trim() === LETTER_HEADING && greeting > 0 && greeting < 8) {
    lines = lines.slice(greeting);
  }

  const signOff = lines.findIndex((line) => line.trim() === SIGN_OFF);
  if (signOff > 0) lines = lines.slice(0, signOff);

  return lines
    .filter((line) => !line.includes(TALK_LINK_PLACEHOLDER) && line.trim() !== TALK_PROMPT)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Where the candidate stands, once the invitation link has done its first job.
 *
 * The same bearer token, and deliberately no more power than it already had:
 * this reads, it never advances the interview, and it answers only about the
 * one session the token names. What it may disclose is decided in
 * domain/candidateStatusModel.ts and services/candidateStatus.ts — no score, no
 * verdict, no competency level, nothing about anybody else.
 */
portalRouter.get('/:token/status', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { statusView: true });
  requireInterviewOver(inv.session);
  const session = await prisma.interviewSession.findUnique({
    where: { id: inv.sessionId },
    select: STATUS_SESSION_SELECT,
  });
  // The invitation resolved but its session did not: a half-finished erasure,
  // or a row removed under us. Nothing to show, and nothing worth a 500.
  if (!session) throw new HttpError(404, 'Invitation not found or expired');
  res.json(await buildCandidateStatus(session, { sentAt: inv.sentAt, createdAt: inv.createdAt }));
}));

/**
 * "I'd rather talk to a person." The same request the link in the feedback
 * email makes (routes/feedbackRequest.ts), reached from the status page
 * instead — one CandidateHumanRequest row, one notification, whichever way in.
 *
 * A POST, never a GET: a link-scanning mail gateway must not be able to put a
 * candidate in front of the hiring team. Idempotent, because pressing a button
 * twice when you are unsure it worked is a thing people do.
 */
portalRouter.post('/:token/talk-to-a-person', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { statusView: true });
  requireInterviewOver(inv.session);
  const claimed = await recordHumanRequestForSession({
    sessionId: inv.sessionId,
    candidateId: inv.session.candidateId,
    tenantId: inv.session.tenantId,
  });
  if (claimed) {
    // Neither a webhook subscriber being down nor a mail hiccup may fail the
    // candidate's request: it is already recorded and visible in the app.
    await emitEvent(inv.session.tenantId, 'candidate.human_request', {
      candidateId: inv.session.candidateId,
      sessionId: inv.sessionId,
      requestedAt: claimed.requestedAt,
    }).catch((err: unknown) => logger.warn({ err, sessionId: inv.sessionId }, 'candidate.human_request webhook failed to emit'));
    await notifyHiringTeam({
      tenantId: inv.session.tenantId,
      candidateId: inv.session.candidateId,
      sessionId: inv.sessionId,
      event: 'human_request',
    }).catch((err: unknown) => logger.warn({ err, sessionId: inv.sessionId }, 'Hiring team notice for a human request was not sent'));
  }
  // The same body on the first press and the fifth, so the answer reveals
  // nothing about what happened before.
  res.json({ requested: true });
}));

const feedbackOptInSchema = z.object({ wantsFeedback: z.boolean() });

/**
 * "Would you like written feedback by email?" — asked once, at the moment the
 * interview finishes, while the candidate is still on the page.
 *
 * Deliberately NOT gated on `requireUnconsumed`. The invitation is consumed the
 * instant the interview finalises, which is precisely when this question is
 * put; requiring an unconsumed invitation would make the answer unrecordable at
 * the only moment it can be asked for.
 *
 * This records an answer and nothing else. It cannot send: everything that
 * reaches a candidate still goes through a person approving it in
 * routes/assessments.ts. A "yes" prepares a draft for the hiring team to edit.
 */
portalRouter.post('/:token/feedback-opt-in', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token);
  const body = feedbackOptInSchema.parse(req.body);
  const { optIn, created } = await recordFeedbackOptIn({
    sessionId: inv.sessionId,
    wantsFeedback: body.wantsFeedback,
    via: 'end-of-interview',
  });
  // 200 rather than 201 on a replay, with the answer already on file. The
  // candidate sees a consistent confirmation either way.
  res.status(created ? 201 : 200).json({
    optIn: { choice: optIn.choice, decidedAt: optIn.decidedAt },
  });
}));

/**
 * A turn as the candidate's room receives it: only what the room uses.
 *
 * The portal is unauthenticated, and the engine's turn carries the competency
 * being assessed, the utterance kind and the session state — the shape of the
 * assessment, handed to the person being assessed. The socket and recruiter
 * routes keep the full shape; they are authenticated and use it.
 */
function candidateTurn(turn: AgentTurnOut) {
  return { turnId: turn.turnId, text: turn.text, done: turn.done, withdrawn: turn.withdrawn };
}

/**
 * What a freshly written reply sets in motion. Withdrawal ends the interview
 * WITHOUT assessing it: finalising here once scored a real candidate 0/100
 * seconds after telling him nothing he said would count against him. Only the
 * request that wrote the turn does this, so a reply handed back to a second
 * caller is not finalised twice.
 */
async function settleTurn(sessionId: string, turn: AgentTurnOut): Promise<boolean> {
  if (turn.withdrawn) {
    await withdrawInterview(sessionId, endReasonFor(turn.kind));
    return false;
  }
  if (turn.done) {
    await finalizeInterview(sessionId);
    return true;
  }
  return false;
}

/** The consent record as the portal reads and extends it. */
interface StoredConsent {
  disclosureText?: string;
  recordingRequested?: unknown;
  [key: string]: unknown;
}

/** The voice a session's interviewer speaks with; null means the configured default voice. */
async function sessionVoice(personaJson: string, sessionId: string) {
  return voiceForInterviewer(interviewerIdOf(personaJson, sessionId));
}

portalRouter.get('/:token', asyncHandler(async (req, res) => {
  const loaded = await loadByToken(req.params.token);
  // A session from before the interviewer catalogue meets its interviewer here,
  // the first time it is opened for the interview. Finished ones are left as
  // they were recorded (see services/interviewers.ts).
  const needsInterviewer = !interviewerIdOf(loaded.session.personaJson, loaded.sessionId);
  if (needsInterviewer) {
    // Never a reason to refuse the page: with no interviewer active (an
    // operator turned them all off) the candidate still sees their invitation.
    await ensureSessionInterviewer(loaded.sessionId).catch((err: unknown) => {
      logger.warn({ sessionId: loaded.sessionId, err: err instanceof Error ? err.message : String(err) }, 'Could not assign an AI interviewer on first open');
    });
  }
  const inv = needsInterviewer ? await loadByToken(req.params.token) : loaded;
  const s = inv.session;
  const interviewerId = interviewerIdOf(s.personaJson, s.id);

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

  // The disclosure shown here is what the candidate consents to; a blank one
  // from a damaged row would be consent to nothing.
  const consent = parseJsonStrict<StoredConsent>(s.consentJson, { model: 'InterviewSession', id: s.id, field: 'consentJson' });
  const proctoringEnabled = await proctoringEnabledForSession({ tenantId: s.tenantId, scorecardId: s.scorecardId });
  const englishDisclosure = await disclosureWithProctoringPolicy({ tenantId: s.tenantId, scorecardId: s.scorecardId }, consent.disclosureText ?? '');

  // The disclosure is resolved through the locale registry AFTER the proctoring
  // sentence is appended, so the resolver sees the complete English notice it
  // may one day have an approved translation of — rather than a translation of
  // half of it.
  //
  // For every language but English this returns that English text back with
  // `translationReviewed: false`. That is the intended behaviour, not a gap:
  // showing the reviewed English notice and SAYING it is English is lawful;
  // showing a machine translation of a consent notice nobody reviewed is not.
  // `languageSupport` is what lets the portal say which of the two happened —
  // and, via `sttLikelySupported`, stop implying a voice path we cannot promise
  // in that language. The typed-answer fallback exists for exactly that case.
  const disclosure = getDisclosureText(s.language, englishDisclosure);

  // The end-of-interview question. `offered` is false unless the tenant has
  // candidate feedback switched on AND the interview has actually finished:
  // asking someone whether they would like feedback we are not able to send
  // would be a promise we do not keep, and it is the kind a candidate remembers.
  const [optInOffered, existingOptIn] = await Promise.all([feedbackOptInOffered(s), getOptIn(s.id)]);
  const schedule = await portalSchedule(s);

  res.json({
    candidateName: s.candidate.fullName,
    roleTitle: s.role.title,
    state: s.state,
    durationMinutes: s.durationMinutes,
    language: s.language,
    languageSupport: describeLanguageSupport(s.language),
    aiDisclosure: disclosure.text,
    recordingRequested: !!consent.recordingRequested,
    // Whether the candidate agreed to have their voice captured. When false the
    // room must not open the microphone; answers are typed instead.
    recordingConsented: s.recordingConsent === true,
    // Whether the candidate has agreed to the interview at all. Past the
    // consent step the portal offers the room only when this is true; without
    // it the room would refuse to start and send them back here.
    consented: hasRecordedConsent(s),
    // The interviewer's name, as HR set it for this session. The pages used
    // to hardcode a default that stopped matching what the AI said aloud.
    // voiceHint only steers which BROWSER voice speaks when there is no server
    // voice; the provider voice itself never leaves the server.
    persona: { name: personaNameOf(s.personaJson, s.id), interviewerId, voiceHint: await voiceHintForInterviewer(interviewerId) },
    privacy: 'Your responses are transcribed and reviewed by our hiring team. This first round is conducted by an AI interviewer. You may request accommodations or a human alternative, and you can withdraw consent at any time.',
    accommodationsEnabled: true,
    proctoringEnabled,
    observerNotice: hasObserverNotice(typeof consent.disclosureText === 'string' ? consent.disclosureText : ''),
    speech: { stt: sttCapability(), tts: ttsCapability() },
    feedbackOptIn: { offered: optInOffered, choice: existingOptIn?.choice ?? null },
    // When the interview is booked for, written in the zone it was booked in
    // (else the organisation's, IST when it has none) so the page and the email agree.
    schedule,
    // The one-time code asked for after consent and before the room opens.
    // Where it goes is shown masked; the code itself never leaves the server.
    identity: await portalIdentityView(s, hasRecordedConsent(s)),
  });
}));

// Once the interview has started, the booking has done its job.
async function portalSchedule(s: { tenantId: string; scheduledAt: Date | null; scheduledTimeZone: string | null; startedAt: Date | null }) {
  if (!s.scheduledAt || s.startedAt) return null;
  const timeZone = s.scheduledTimeZone ?? await tenantTimeZone(s.tenantId);
  return { at: s.scheduledAt, timeZone, text: formatScheduledTime(s.scheduledAt, timeZone) };
}


const integrityEventSchema = z.object({
  type: z.enum(INTEGRITY_EVENT_TYPES),
  detail: z.record(z.unknown()).optional(),
});

portalRouter.post('/:token/integrity-event', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  const body = integrityEventSchema.parse(req.body);
  const enabled = await proctoringEnabledForSession({ tenantId: inv.session.tenantId, scorecardId: inv.session.scorecardId });
  const consent = parseJsonOptional<Record<string, unknown>>(inv.session.consentJson, {}, { model: 'InterviewSession', id: inv.sessionId, field: 'consentJson' });

  // Stored only when this candidate's own consent covered monitoring, and never
  // for a candidate who asked for an accommodation: screen readers and switch
  // access produce exactly the focus-loss signals being recorded.
  const consentCoveredMonitoring = consent.monitoringDisclosed === true;
  const accommodated = typeof consent.accommodationRequest === 'string' && consent.accommodationRequest.length > 0;
  if (!enabled || !consent.consentedAt || !consentCoveredMonitoring || accommodated || !INTEGRITY_EVENT_STATES.includes(inv.session.state)) {
    return res.status(202).json({ ok: true, accepted: false });
  }

  const detail = JSON.stringify(body.detail ?? {});
  if (detail.length > 2000) {
    return res.status(202).json({ ok: true, accepted: false });
  }

  try {
    await prisma.integrityEvent.create({ data: { sessionId: inv.sessionId, type: body.type, detail } });
    return res.status(202).json({ ok: true, accepted: true });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId: inv.sessionId, type: body.type }, 'Integrity event was not stored');
    return res.status(202).json({ ok: true, accepted: false });
  }
}));

portalRouter.post('/:token/accept', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  // Conditional, so a double-tap accepts (and emits the webhook) once.
  const { count } = inv.session.state === 'INVITED'
    ? await prisma.interviewSession.updateMany({ where: { id: inv.sessionId, state: 'INVITED' }, data: { state: 'ACCEPTED' } })
    : { count: 0 };
  if (count === 1) {
    await prisma.invitation.update({ where: { id: inv.id }, data: { status: 'accepted', acceptedAt: new Date() } });
    await emitEvent(inv.session.tenantId, 'invitation.accepted', { sessionId: inv.sessionId });
    await logAudit({ tenantId: inv.session.tenantId, actorType: 'user', actorId: 'candidate', action: 'invitation.accepted', entityType: 'InterviewSession', entityId: inv.sessionId });
  }
  // The state the session is really in. This always said ACCEPTED, so a
  // candidate who had asked for a person, or already finished, was shown a page
  // that thought they were about to begin.
  const current = count === 1 ? null : await prisma.interviewSession.findUnique({ where: { id: inv.sessionId }, select: { state: true } });
  res.json({ ok: true, state: current?.state ?? 'ACCEPTED' });
}));

const consentSchema = z.object({
  recordingConsent: z.boolean(),
  accepted: z.boolean(),
  // Bounded: it is stored on the session and shown to a person, and nothing a
  // human is meant to read and act on needs to be longer than this.
  accommodationRequest: z.string().max(ACCOMMODATION_MAX_LENGTH).optional(),
  // Whether the portal page the candidate consented on displayed the browser
  // monitoring notice. Policy can change between page load and consent.
  monitoringNoticeShown: z.boolean().optional(),
  // Whether that page also told the candidate a member of the hiring team may observe.
  observerNoticeShown: z.boolean().optional(),
});
portalRouter.post('/:token/consent', asyncHandler(async (req, res) => {
  const loaded = await loadByToken(req.params.token, { requireUnconsumed: true });
  if (!PRE_INTERVIEW_STATES.includes(loaded.session.state)) throw new HttpError(409, FINISHED_MESSAGE);
  // The page may have been opened before this session got its interviewer (a
  // tab left open across a deploy, or a failed assignment the portal page
  // ignored). Assign it here too, so the disclosure check below sees the
  // named wording instead of refusing the candidate.
  await ensureSessionInterviewer(loaded.sessionId).catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err), sessionId: loaded.sessionId }, 'Could not assign an interviewer before consent');
  });
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  const body = consentSchema.parse(req.body);
  if (!body.accepted) throw new HttpError(400, 'Consent to proceed is required, or choose the human-alternative path.');

  const accommodation = body.accommodationRequest?.trim();
  // A real request, not a stray keystroke. A candidate who typed one character
  // was previously converted to a handoff with no way back — a one-way door
  // triggered by an accident.
  //
  // But a short request must not be dropped on the floor either: for a while
  // "more time" (nine characters) recorded ordinary consent and moved the
  // candidate into the audio check, and the accommodation they asked for
  // existed nowhere. Too short to act on is an answer, not a silence.
  if (accommodation && accommodation.length < ACCOMMODATION_MIN_LENGTH) {
    throw new HttpError(400, `Tell us a little more about what you need (at least ${ACCOMMODATION_MIN_LENGTH} characters), or clear the box to continue without a request.`);
  }
  if (accommodation && accommodation.length >= ACCOMMODATION_MIN_LENGTH) {
    // PERSIST WHAT THEY ASKED FOR. The previous version set the state and logged
    // that "an accommodation was requested" while discarding the request itself,
    // so the human meant to follow up had nothing to follow up on — the one
    // thing the handoff exists to deliver.
    const consent = parseJsonStrict<Record<string, unknown>>(inv.session.consentJson, { model: 'InterviewSession', id: inv.sessionId, field: 'consentJson' });
    consent.accommodationRequest = accommodation;
    consent.accommodationRequestedAt = new Date().toISOString();
    await prisma.interviewSession.update({
      where: { id: inv.sessionId },
      data: { state: 'MANUAL_HANDOFF', consentJson: JSON.stringify(consent) },
    });
    await logAudit({
      tenantId: inv.session.tenantId, actorType: 'user', actorId: 'candidate',
      action: 'accommodation.requested', entityType: 'InterviewSession', entityId: inv.sessionId,
      after: { request: accommodation },
    });
    // The candidate is promised a follow-up, so a person has to hear about it.
    // Neither carries the request itself: it can describe a health condition.
    await emitEvent(inv.session.tenantId, 'interview.accommodation_requested', { sessionId: inv.sessionId, candidateId: inv.session.candidateId })
      .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId: inv.sessionId }, 'accommodation webhook failed to emit'));
    await notifyHiringTeam({ tenantId: inv.session.tenantId, candidateId: inv.session.candidateId, sessionId: inv.sessionId, event: 'accommodation_request' });
    return res.json({
      ok: true, handoff: true,
      message: 'Thanks — your request has been sent to our team and someone will contact you to arrange an alternative. You do not need to do anything else.',
    });
  }

  // Strict because it is written back: a damaged record would be replaced by
  // a consent to an empty disclosure, destroying the evidence of the original.
  const consent = parseJsonStrict<StoredConsent>(inv.session.consentJson, { model: 'InterviewSession', id: inv.sessionId, field: 'consentJson' });
  // Fail closed. The interview no longer announces the AI aloud, so this page
  // is the one place the candidate is told; a session whose disclosure does
  // not open by naming the AI interviewer (empty, damaged, or from a path that
  // never wrote one) must not collect a consent that would claim otherwise.
  // A candidate who already consented agreed to exactly the stored text, even
  // if it predates the named wording; consent does not move the state, so they
  // come back through this step and must not be locked out.
  if (!hasRecordedConsent(inv.session) && !hasConsentIntro(typeof consent.disclosureText === 'string' ? consent.disclosureText : '')) {
    logger.error({ sessionId: inv.sessionId }, 'Consent refused: the stored disclosure does not name the AI interviewer');
    throw new HttpError(409, 'This interview is not ready yet. Please contact the hiring team, who can send you a fresh link.', 'disclosure_missing');
  }
  // Record what the candidate was actually shown. Without this there is no
  // durable proof browser monitoring was disclosed, and switching monitoring on
  // later would silently extend to people who consented before it existed.
  // Disclosure requires BOTH that the page showed the notice and that policy
  // still enables monitoring now: policy can flip either way between the page
  // loading and the candidate pressing consent.
  const policyScope = { tenantId: inv.session.tenantId, scorecardId: inv.session.scorecardId };
  const monitoringDisclosed = body.monitoringNoticeShown === true && await proctoringEnabledForSession(policyScope);
  consent.recording = body.recordingConsent;
  consent.consentVersion = 'v2';
  consent.consentedAt = new Date().toISOString();
  consent.channel = 'portal';
  consent.monitoringDisclosed = monitoringDisclosed;
  // Live observation by HR is allowed only if the page they consented on said so.
  consent.observerDisclosed = body.observerNoticeShown === true
    && hasObserverNotice(typeof consent.disclosureText === 'string' ? consent.disclosureText : '');
  consent.disclosureShown = monitoringDisclosed
    ? await disclosureWithProctoringPolicy(policyScope, consent.disclosureText ?? '')
    : (consent.disclosureText ?? '');
  // Which identity check this consent commits to, frozen here: the page said
  // so before the candidate agreed, and a later change of setting or of mail
  // delivery must not move the goalposts for someone on their way in.
  consent.identityCheck = await identityCheckForConsent(inv.session.tenantId, inv.session.candidate.email);
  await prisma.interviewSession.update({
    where: { id: inv.sessionId },
    data: { consentJson: JSON.stringify(consent), recordingConsent: body.recordingConsent },
  });
  await logAudit({ tenantId: inv.session.tenantId, actorType: 'user', actorId: 'candidate', action: 'consent.recorded', entityType: 'InterviewSession', entityId: inv.sessionId, after: { recording: body.recordingConsent, monitoringDisclosed } });
  // The identity check this consent just recorded, so the page moves to the
  // step the server will actually require rather than to what it previewed.
  const identity = await portalIdentityView({ ...inv.session, consentJson: JSON.stringify(consent) }, true);
  res.json({ ok: true, recordingConsent: body.recordingConsent, identity });
}));

/**
 * Identity assurance L1: email the candidate a one-time code. Only after
 * consent recorded that a code applies, and only before the interview is live.
 * The response names where it went (masked) and never carries the code.
 */
portalRouter.post('/:token/identity/code', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  if (!PRE_INTERVIEW_STATES.includes(inv.session.state)) throw new HttpError(409, FINISHED_MESSAGE);
  if (!hasRecordedConsent(inv.session)) throw new HttpError(409, 'Please agree to the interview first. We send the code after that.', 'consent_required');
  if (recordedIdentityCheck(inv.session)?.method !== 'email_code') throw new HttpError(409, 'No code is needed for this interview.', 'identity_code_not_needed');
  const out = await issueIdentityCode(inv.sessionId);
  switch (out.kind) {
    case 'sent':
      return res.json({ sent: true, channel: 'email', destination: out.destination, expiresInSeconds: CODE_TTL_MS / 1000, resendAfterSeconds: out.resendAfterSeconds });
    case 'already_verified':
      return res.json({ sent: false, verified: true });
    case 'wait':
      // A code went out a moment ago: not an error for the candidate, who
      // should use it. They are told when they can ask for another.
      if (out.reason === 'cooldown') {
        return res.json({ sent: false, destination: maskEmail(inv.session.candidate.email), retryAfterSeconds: out.retryAfterSeconds });
      }
      res.setHeader('Retry-After', String(out.retryAfterSeconds));
      return res.status(429).json({
        error: out.reason === 'locked'
          ? 'The last code was entered incorrectly too many times, so it was cancelled. You can ask for a new one in a few minutes.'
          : 'We have sent several codes in the last hour. Please check your inbox and spam folder, or try again later.',
        code: out.reason === 'locked' ? 'identity_code_locked' : 'identity_code_limit',
        retryAfterSeconds: out.retryAfterSeconds,
      });
    case 'not_delivered':
      return res.status(503).json({ error: 'We could not send the email just now. Please try again in a moment.', code: 'identity_code_not_sent' });
  }
}));

const identityCodeSchema = z.object({ code: z.string().max(32) });

portalRouter.post('/:token/identity/verify', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  if (!PRE_INTERVIEW_STATES.includes(inv.session.state)) throw new HttpError(409, FINISHED_MESSAGE);
  // A malformed entry is a typo, not a guess: refused before it is counted.
  const code = normalizeCode(identityCodeSchema.parse(req.body).code);
  if (!code) throw new HttpError(400, 'Enter the 6-digit code from the email.', 'identity_code_format');
  const out = await verifyIdentityCode(inv.sessionId, code);
  switch (out.kind) {
    case 'verified':
      return res.json({ verified: true });
    case 'wrong':
      return res.status(400).json({
        error: `That code does not match. You have ${out.attemptsLeft} ${out.attemptsLeft === 1 ? 'try' : 'tries'} left.`,
        code: 'identity_code_wrong', attemptsLeft: out.attemptsLeft,
      });
    case 'locked':
      res.setHeader('Retry-After', String(out.retryAfterSeconds));
      return res.status(429).json({
        error: 'That code was entered incorrectly too many times, so we cancelled it to keep your interview safe. You can ask for a new code shortly.',
        code: 'identity_code_locked', retryAfterSeconds: out.retryAfterSeconds,
      });
    case 'expired':
      return res.status(400).json({ error: 'This code has expired. Please ask for a new one.', code: 'identity_code_expired' });
  }
}));

portalRouter.post('/:token/techcheck', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  if (!PRE_INTERVIEW_STATES.includes(inv.session.state)) throw new HttpError(409, FINISHED_MESSAGE);
  const body = z.object({ mic: z.boolean(), speaker: z.boolean() }).parse(req.body);
  const quality = parseJsonOptional<Record<string, unknown>>(inv.session.qualityJson, {}, { model: 'InterviewSession', id: inv.sessionId, field: 'qualityJson' });
  quality.techCheck = { ...body, at: new Date().toISOString() };
  await prisma.interviewSession.update({ where: { id: inv.sessionId }, data: { qualityJson: JSON.stringify(quality) } });
  res.json({ ok: true, ready: body.mic && body.speaker });
}));

// Text-mode fallback endpoints (used when Web Speech is unavailable). The
// primary path is the Socket.IO room, but these keep the interview fully
// completable over plain HTTP.
portalRouter.post('/:token/start', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  // A live session resumes: the pending question plus the conversation so far,
  // so a reload or a return through the link does not replay the opening.
  const { turn, resumed, history, awaitingReply, pendingAnswerAgeMs, elapsedMs } = await startOrResumeInterview(inv.sessionId);
  res.json({ turn: candidateTurn(turn), resumed, history, awaitingReply, pendingAnswerAgeMs, elapsedMs });
}));
/**
 * The candidate's last answer has no reply and they have nothing to add.
 * Idempotent: see continueAfterAnswer. Guarded exactly like /turn — same token
 * and consumption checks here, same rate-limit bucket in app.ts.
 */
portalRouter.post('/:token/continue', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  const { turn, produced } = await continueAfterAnswer(inv.sessionId);
  const assessmentReady = produced ? await settleTurn(inv.sessionId, turn) : false;
  res.json({ turn: candidateTurn(turn), assessmentReady });
}));
portalRouter.post('/:token/turn', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  // Unauthenticated route where every call funds an LLM prompt. The 2mb Express
  // JSON limit is not a spend limit, so bound the answer here: a spoken reply
  // runs a few hundred characters, far under this ceiling.
  const { text, startMs, endMs, inReplyTo, leaving } = z.object({
    text: z.string().min(1).max(MAX_TURN_TEXT_CHARS),
    // The Leave button: recorded as that action and withdrawn, whatever the text.
    leaving: z.boolean().optional(),
    // The question on the candidate's screen. Optional for older rooms; when
    // present, an answer to a question the interview has moved past is
    // refused rather than credited to one they never saw.
    inReplyTo: z.string().min(1).max(64).optional(),
    // Stored and shown to reviewers as when the answer was given; unbounded
    // numbers let a browser distort pacing and the transcript's timestamps.
    // The room sends null when the moment is genuinely unknown (a typed
    // answer); that means "no stamp", the same as leaving the field out.
    startMs: z.number().int().min(0).max(MAX_TURN_MS).nullish().transform((v) => v ?? undefined),
    endMs: z.number().int().min(0).max(MAX_TURN_MS).nullish().transform((v) => v ?? undefined),
  }).refine((b) => b.startMs === undefined || b.endMs === undefined || b.endMs >= b.startMs, { message: 'endMs must not be before startMs.' }).parse(req.body);
  const { turn, produced } = await submitCandidateAnswer(inv.sessionId, text, { startMs, endMs }, { inReplyTo, leaving });
  const assessmentReady = produced ? await settleTurn(inv.sessionId, turn) : false;
  res.json({ turn: candidateTurn(turn), assessmentReady });
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

  // What is spoken: the stored turn — or, when a rejoin puts only an opening's
  // question again, that question as the SERVER derives it from the stored
  // turn. The request only chooses between the two; the words synthesised
  // are always server-written, and anything else in the body is ignored.
  const question = openingQuestion(turn.text);
  const spoken = body.turnId && body.text && question !== turn.text && body.text.trim() === question ? question : turn.text;

  // A stored turn longer than the cap is legitimate content, not an attack, so
  // fall back to browser speech rather than failing the interview over it.
  if (spoken.length > MAX_SPEAK_TEXT_CHARS) {
    logger.warn({ sessionId: inv.sessionId, turnId: turn.id, chars: spoken.length }, 'Agent turn exceeds TTS cap; falling back to browser speech');
    return res.status(204).end();
  }

  // Nothing configured to speak with: tell the client to use browser speech.
  const voice = await sessionVoice(inv.session.personaJson, inv.sessionId);
  if (!(await serverSpeechAllowed(inv.sessionId, () => serverTtsReady(voice)))) return res.status(204).end();

  // Answer conditional requests BEFORE synthesizing. The ETag is a pure
  // function of (provider, model, voice, text), so it can be computed without
  // calling the vendor — checking it afterwards would save bandwidth but still
  // pay for the audio, which defeats the point. The voice is the session
  // interviewer's, so a changed interviewer never matches another's audio.
  const etag = speechEtag(spoken, voice);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  let speech: Awaited<ReturnType<typeof synthesizeServerSpeech>>;
  try {
    speech = await synthesizeServerSpeech(spoken, voice);
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
 * What the interviewer says when a candidate has gone quiet for a long time.
 *
 * The phrases live here, not on the client, for the same reason `/speak` will
 * only synthesize a stored turn: if the caller supplied the words, this would
 * be an open text-to-speech endpoint billed to the operator. The client sends
 * an index; the server decides what is said.
 *
 * They escalate. The first is a reassurance and nothing more — a candidate who
 * is thinking should not be made to feel rushed, which is the whole risk of
 * speaking into their silence at all. Only later do they offer a way out.
 */
const SILENCE_PROMPTS = [
  'Take your time — there is no rush at all. I am still here whenever you are ready.',
  'No hurry. If it would help, I can repeat the question, or you can type your answer instead.',
  'I will wait. If you would rather come back to this one, just say so and we can move on.',
];

const nudgeSchema = z.object({ index: z.number().int().min(0).max(SILENCE_PROMPTS.length - 1) });

portalRouter.post('/:token/nudge', asyncHandler(async (req, res) => {
  const inv = await loadByToken(req.params.token, { requireUnconsumed: true });
  const { index } = nudgeSchema.parse(req.body);
  const text = SILENCE_PROMPTS[index];

  // Sent as a header so the client can caption it and, when there is no server
  // voice, speak it locally — without the phrase list having to exist twice.
  res.setHeader('X-Nudge-Text', encodeURIComponent(text));
  res.setHeader('Access-Control-Expose-Headers', 'X-Nudge-Text');

  const voice = await sessionVoice(inv.session.personaJson, inv.sessionId);
  if (!(await serverSpeechAllowed(inv.sessionId, () => serverTtsReady(voice)))) return res.status(204).end();

  const etag = speechEtag(text, voice);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  let speech: Awaited<ReturnType<typeof synthesizeServerSpeech>>;
  try {
    speech = await synthesizeServerSpeech(text, voice);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), sessionId: inv.sessionId }, 'Nudge TTS failed; falling back to browser speech');
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
  // The consent box was recorded but never enforced: a candidate who left it
  // unticked had their voice sent to the transcription vendor regardless.
  // Declining voice capture means typing the answers, and this is the seam
  // where that has to hold whatever the page did.
  if (inv.session.recordingConsent !== true) {
    throw new HttpError(409, 'Voice capture was not agreed to for this interview. Please type your answer instead.');
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
  if (!(await serverSpeechAllowed(inv.sessionId, serverSttReady))) return res.status(204).end();

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
