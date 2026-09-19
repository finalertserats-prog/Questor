import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import {
  audioBytesMatchMimeType, isTranscribableMimeType, serverSttReady, sttCapability, transcribeServerSpeech,
} from '../providers/speech.js';
import { logAudit } from '../services/audit.js';
import { extractEvidenceQuotes } from '../services/observerQuotes.js';
import {
  OBSERVER_CAPTURE_NOTICE, appendSegment, assertCapturing, candidateConsents, candidateDeclines, candidateStops,
  candidateView, endObservation, findByCandidateToken, interviewerConsents, interviewerDeclines, interviewerStops,
  loadRoundForStaff, observationForRound, observerApplies, presentObservation, startListening,
  type RoundWithPipeline,
} from '../services/roundObserver.js';

/**
 * The AI observer on human rounds: the interviewer's room (authenticated) and
 * the candidate's consent link (public, token-gated). The rules live in
 * services/roundObserver.ts; this file is transport.
 */
export const observerRouter = Router();
observerRouter.use(authenticate);

// One chunk of a round, not the round: the room uploads every ~30 seconds.
const MAX_CHUNK_BYTES = 10 * 1024 * 1024;
// A round that runs long is still a round; beyond a day the offset is nonsense.
const MAX_OFFSET_MS = 24 * 60 * 60 * 1000;
const MAX_SEGMENT_CHARS = 8000;
// How long ending a round waits for quotes before answering. The heuristic
// path settles at once; a slow model finishes in the background and the room
// polls for the result.
const END_WAIT_MS = 15_000;

const uploadChunk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHUNK_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isTranscribableMimeType(file.mimetype)) {
      cb(new HttpError(400, 'Only audio uploads (webm, ogg, mp4, m4a, mp3, wav) are accepted'));
      return;
    }
    cb(null, true);
  },
});

function receiveChunk(req: Request, res: Response, next: NextFunction): void {
  // JSON bodies (browser speech recognition) skip multer entirely.
  if (!req.is('multipart/form-data')) { next(); return; }
  uploadChunk.single('audio')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Upload rejected: audio exceeds the 10 MB limit' : 'Upload rejected: send one audio chunk'));
      return;
    }
    next(err);
  });
}

const timing = {
  offsetMs: z.coerce.number().int().min(0).max(MAX_OFFSET_MS),
  durationMs: z.coerce.number().int().min(0).max(MAX_OFFSET_MS).default(0),
};
const textSegmentSchema = z.object({ ...timing, text: z.string().max(MAX_SEGMENT_CHARS) });
const audioSegmentSchema = z.object(timing);
const gapSchema = z.object({ ...timing, reason: z.string().trim().max(80).regex(/^[a-z0-9_-]*$/i).default('') });

async function view(req: Request, round: RoundWithPipeline) {
  const observation = await observationForRound(round.id);
  const stt = sttCapability();
  return {
    round: {
      id: round.id, candidateId: round.pipeline.candidateId, stageKey: round.stageKey, status: round.status,
      aiObserver: observerApplies(round), scheduledAt: round.scheduledAt,
    },
    notice: OBSERVER_CAPTURE_NOTICE,
    capture: { mode: serverSttReady() ? 'server' : 'browser', provider: stt.provider },
    observation: observation ? presentObservation(observation, req.auth!.userId) : null,
  };
}

observerRouter.get('/rounds/:roundId', requireCapability('interview:read'), asyncHandler(async (req, res) => {
  res.json(await view(req, await loadRoundForStaff(req.auth!, req.params.roundId)));
}));

observerRouter.post('/rounds/:roundId/consent', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const round = await loadRoundForStaff(req.auth!, req.params.roundId);
  await interviewerConsents(req.auth!, round);
  res.status(201).json(await view(req, round));
}));

observerRouter.post('/rounds/:roundId/decline', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const round = await loadRoundForStaff(req.auth!, req.params.roundId);
  await interviewerDeclines(req.auth!, round);
  res.json(await view(req, round));
}));

observerRouter.post('/rounds/:roundId/start', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const round = await loadRoundForStaff(req.auth!, req.params.roundId);
  await startListening(req.auth!, round);
  res.json(await view(req, round));
}));

observerRouter.post('/rounds/:roundId/stop', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const round = await loadRoundForStaff(req.auth!, req.params.roundId);
  await interviewerStops(req.auth!, round);
  res.json(await view(req, round));
}));

/** Run extraction, answering once it settles or after END_WAIT_MS, whichever is first. */
async function extractWithDeadline(observationId: string): Promise<void> {
  const work = extractEvidenceQuotes(observationId).catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err), observationId }, 'Observer quote extraction crashed');
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, END_WAIT_MS); });
  await Promise.race([work, deadline]);
  clearTimeout(timer);
}

observerRouter.post('/rounds/:roundId/end', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const round = await loadRoundForStaff(req.auth!, req.params.roundId);
  const observationId = await endObservation(round.id, req.auth!.userId);
  if (!observationId) throw new HttpError(409, 'There is no observer to end on this round.');
  await extractWithDeadline(observationId);
  res.json(await view(req, round));
}));

// Retry after an outage. READY quotes are never rewritten.
observerRouter.post('/rounds/:roundId/quotes', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const round = await loadRoundForStaff(req.auth!, req.params.roundId);
  const observation = await observationForRound(round.id);
  if (!observation || observation.status !== 'ENDED' || observation.quotesStatus !== 'UNAVAILABLE') {
    throw new HttpError(409, 'Quotes can only be retried for an ended round whose extraction was unavailable.');
  }
  await extractWithDeadline(observation.id);
  res.json(await view(req, round));
}));

observerRouter.post('/rounds/:roundId/segments', requireCapability('interview:schedule'), receiveChunk, asyncHandler(async (req, res) => {
  const round = await loadRoundForStaff(req.auth!, req.params.roundId);
  // Consent, identity and state are checked before a byte is sent to a vendor.
  const observation = await assertCapturing(req.auth!, round);

  // Audio goes to a paid transcription vendor; a demo may send typed or
  // browser-captioned text only.
  if (req.file && req.auth!.demo === true) throw new HttpError(403, 'In the demo, observer notes use browser captions or typed text.');
  if (!req.file) {
    const body = textSegmentSchema.parse(req.body);
    const text = body.text.trim();
    if (!text) { res.json({ captured: true, segment: null }); return; }
    const segment = await appendSegment(observation, round.id, { kind: 'SPEECH', offsetMs: body.offsetMs, durationMs: body.durationMs, text, source: 'browser' });
    res.status(201).json({ captured: true, segment: { index: segment.index, offsetMs: segment.offsetMs } });
    return;
  }

  const timingBody = audioSegmentSchema.parse(req.body);
  if (!req.file.buffer.length || !audioBytesMatchMimeType(req.file.buffer, req.file.mimetype)) {
    throw new HttpError(400, 'The uploaded audio does not match its declared file type.');
  }
  if (!serverSttReady()) throw new HttpError(422, 'Server transcription is not configured; capture with the browser instead.');

  let text: string | null = null;
  let failure = '';
  try {
    text = await transcribeServerSpeech(req.file.buffer, req.file.mimetype);
    if (text === null) failure = 'transcription-unavailable';
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), roundId: round.id }, 'Observer transcription failed');
    failure = 'transcription-failed';
  }
  // Audio is never stored: only the words, or the fact that there are none.
  if (failure) {
    await appendSegment(observation, round.id, { kind: 'GAP', offsetMs: timingBody.offsetMs, durationMs: timingBody.durationMs, text: '', source: failure });
    res.json({ captured: false, reason: 'Transcription is unavailable, so this part of the round was not captured.' });
    return;
  }
  const trimmed = (text ?? '').trim();
  if (!trimmed) { res.json({ captured: true, segment: null }); return; }
  const segment = await appendSegment(observation, round.id, {
    kind: 'SPEECH', offsetMs: timingBody.offsetMs, durationMs: timingBody.durationMs, text: trimmed.slice(0, MAX_SEGMENT_CHARS), source: sttCapability().provider,
  });
  res.status(201).json({ captured: true, segment: { index: segment.index, offsetMs: segment.offsetMs } });
}));

// The room's own microphone or recogniser failed for a stretch.
observerRouter.post('/rounds/:roundId/capture-gap', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const body = gapSchema.parse(req.body);
  const round = await loadRoundForStaff(req.auth!, req.params.roundId);
  const observation = await assertCapturing(req.auth!, round);
  await appendSegment(observation, round.id, { kind: 'GAP', offsetMs: body.offsetMs, durationMs: body.durationMs, text: '', source: body.reason || 'client' });
  res.status(201).json({ captured: false });
}));

observerRouter.patch('/observations/:id/retention', requireCapability('retention:configure'), asyncHandler(async (req, res) => {
  const { legalHold } = z.object({ legalHold: z.boolean() }).parse(req.body);
  const observation = await prisma.roundObservation.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!observation) throw new HttpError(404, 'Observation not found');
  await prisma.roundObservation.update({ where: { id: observation.id }, data: { legalHold } });
  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'observer.retention_updated', entityType: 'RoundObservation', entityId: observation.id,
    before: { legalHold: observation.legalHold }, after: { legalHold },
  });
  res.json({ observation: { id: observation.id, legalHold } });
}));

/** The candidate's side. No session: the link is the credential. */
export const observerConsentRouter = Router();

observerConsentRouter.get('/:token', asyncHandler(async (req, res) => {
  res.json(await candidateView(await findByCandidateToken(req.params.token)));
}));

observerConsentRouter.post('/:token/consent', asyncHandler(async (req, res) => {
  const observation = await findByCandidateToken(req.params.token);
  await candidateConsents(observation);
  res.json(await candidateView(await findByCandidateToken(req.params.token)));
}));

observerConsentRouter.post('/:token/decline', asyncHandler(async (req, res) => {
  const observation = await findByCandidateToken(req.params.token);
  await candidateDeclines(observation);
  res.json(await candidateView(await findByCandidateToken(req.params.token)));
}));

observerConsentRouter.post('/:token/stop', asyncHandler(async (req, res) => {
  const observation = await findByCandidateToken(req.params.token);
  await candidateStops(observation);
  res.json(await candidateView(await findByCandidateToken(req.params.token)));
}));
