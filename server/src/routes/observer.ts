import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { asyncHandler, authenticate, requireAnyCapability, requireCapability, HttpError } from '../middleware/index.js';
import {
  audioBytesMatchMimeType, isTranscribableMimeType, serverSttReady, sttCapability, transcribeServerSpeech,
} from '../providers/speech.js';
import { logAudit } from '../services/audit.js';
import { expireStalePendingQuotes, extractEvidenceQuotes } from '../services/observerQuotes.js';
import {
  OBSERVER_CAPTURE_NOTICE, appendSegment, assertCapturing, candidateConsents, candidateDeclines, candidateStops,
  candidateView, consentToEntry, declineEntry, endObservation, ensureObservation, enterRoom, entryGateFor,
  captureWatch, findByCandidateToken, heardFrom, loadSeat, mayExtract, observationForRound, observerApplies, participantRow,
  participantStops, presentObservation,
  type RoundWithPipeline,
} from '../services/roundObserver.js';
import type { ObservedParty } from '../domain/observedRound.js';

/**
 * The AI observer on human rounds: the room everyone conducting or attending
 * opens (authenticated) and the candidate's entry link (public, token-gated).
 * The rules live in services/roundObserver.ts and domain/observedRound.ts;
 * this file is transport.
 *
 * Every route that could admit somebody or accept audio is gated on the same
 * two helpers — `loadSeat` for who they are in this round, and
 * `assertCapturing` for whether anything may be captured from them. There is
 * no route here that reaches the database without one of them.
 */

/**
 * Who may open an observed round's room.
 *
 * `interview:read` is the hiring team, who reach it through the candidate.
 * `observer:attend` is the narrow grant that lets somebody seated on a round —
 * a subject-matter expert — be observed while conducting it; on its own it
 * reaches no round they are not seated on (domain/capabilities.ts).
 */
const IN_THE_ROOM = requireAnyCapability('interview:read', 'observer:attend');

/**
 * The round must still be one somebody can be admitted to.
 *
 * Checked on every route that changes who is in the room rather than once on
 * load, because "the round is over" and "this round has no observer" are the
 * two ways an entry gate could otherwise be passed for a room that no longer
 * exists — and a consent recorded against one is a consent to nothing.
 */
function requireLiveRoom(round: RoundWithPipeline): void {
  if (!observerApplies(round)) throw new HttpError(409, 'This round does not have an AI observer.');
  if (round.status !== 'SCHEDULED') throw new HttpError(409, 'This round has already ended.');
}
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

async function view(req: Request, round: RoundWithPipeline, party: ObservedParty) {
  await expireStalePendingQuotes(round.id);
  const observation = await observationForRound(round.id);
  const stt = sttCapability();
  return {
    round: {
      id: round.id, candidateId: round.pipeline.candidateId, stageKey: round.stageKey, status: round.status,
      aiObserver: observerApplies(round), scheduledAt: round.scheduledAt, scheduledTimeZone: round.scheduledTimeZone,
    },
    // Which of the room's parties this reader is. The room words the notice
    // and the controls from this rather than guessing from what it can see.
    you: { party },
    notice: OBSERVER_CAPTURE_NOTICE,
    // Whether the round is being heard at all, and by how many voices. Both
    // travel on every read of the room, because both are only worth knowing
    // while the round is still running and can still be put right.
    capture: {
      mode: serverSttReady() ? 'server' : 'browser', provider: stt.provider,
      ...(observation ? captureWatch(observation) : {}),
    },
    gate: observation ? entryGateFor(observation, round, req.auth!.userId) : null,
    observation: observation ? presentObservation(observation, req.auth!.userId, round) : null,
  };
}

observerRouter.get('/rounds/:roundId', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  // Created on sight rather than by a press. Nobody starts the observer on a
  // human round; the only thing anyone decides is whether they will be in it.
  if (observerApplies(round)) {
    // A row for this reader too, with no consent on it. It is what lets the
    // room show them the notice and tell them apart from somebody merely
    // reading the transcript afterwards; it grants nothing on its own.
    await participantRow(await ensureObservation(round), party, req.auth!.userId);
  }
  res.json(await view(req, round, party));
}));

// Agreeing to be recorded IS joining. There is no separate "start the
// observer": a person who has agreed and entered is being captured, and a
// person who has not is not in the room.
observerRouter.post('/rounds/:roundId/consent', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  requireLiveRoom(round);
  await consentToEntry(await ensureObservation(round), party, req.auth!.userId, req.auth!.userId);
  res.status(201).json(await view(req, round, party));
}));

observerRouter.post('/rounds/:roundId/decline', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  requireLiveRoom(round);
  await declineEntry(await ensureObservation(round), party, req.auth!.userId, req.auth!.userId);
  res.json(await view(req, round, party));
}));

observerRouter.post('/rounds/:roundId/join', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  requireLiveRoom(round);
  await enterRoom(await ensureObservation(round), round, party, req.auth!.userId, req.auth!.userId);
  res.json(await view(req, round, party));
}));

observerRouter.post('/rounds/:roundId/stop', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  requireLiveRoom(round);
  await participantStops(await ensureObservation(round), party, req.auth!.userId);
  res.json(await view(req, round, party));
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

// Ending capture is part of being in the room, so whoever conducted the round
// may do it. It closes the record; it moves nobody between stages.
observerRouter.post('/rounds/:roundId/end', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  const ended = await endObservation(round.id, req.auth!.userId);
  if (!ended) throw new HttpError(409, 'There is no observer to end on this round.');
  if (ended.mayExtractQuotes) await extractWithDeadline(ended.observationId);
  res.json(await view(req, round, party));
}));

// Retry after an outage. READY quotes are never rewritten.
observerRouter.post('/rounds/:roundId/quotes', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  await expireStalePendingQuotes(round.id);
  const observation = await observationForRound(round.id);
  if (!observation || observation.status !== 'ENDED' || observation.quotesStatus !== 'UNAVAILABLE') {
    throw new HttpError(409, 'Quotes can only be retried for an ended round whose extraction was unavailable.');
  }
  // The same three questions the first attempt was asked. A retry is a second
  // attempt at extraction, not a second opinion on whether it is allowed.
  if (!mayExtract(observation, observation.segments.filter((segment) => segment.kind === 'SPEECH').length)) {
    throw new HttpError(409, 'This round did not produce a transcript of the interview, so there are no quotes to take from it.');
  }
  await extractWithDeadline(observation.id);
  res.json(await view(req, round, party));
}));

observerRouter.post('/rounds/:roundId/segments', IN_THE_ROOM, receiveChunk, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  // Consent, identity and state are checked before a byte is sent to a vendor.
  const seat = await assertCapturing(req.auth!, round, party);

  // Audio goes to a paid transcription vendor; a demo may send typed or
  // browser-captioned text only.
  if (req.file && req.auth!.demo === true) throw new HttpError(403, 'In the demo, observer notes use browser captions or typed text.');
  if (!req.file) {
    const body = textSegmentSchema.parse(req.body);
    const text = body.text.trim();
    if (!text) { res.json({ captured: true, segment: null }); return; }
    const segment = await appendSegment(seat, round.id, { kind: 'SPEECH', offsetMs: body.offsetMs, durationMs: body.durationMs, text, source: 'browser' });
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
    await appendSegment(seat, round.id, { kind: 'GAP', offsetMs: timingBody.offsetMs, durationMs: timingBody.durationMs, text: '', source: failure });
    res.json({ captured: false, reason: 'Transcription is unavailable, so this part of the round was not captured.' });
    return;
  }
  const trimmed = (text ?? '').trim();
  if (!trimmed) { res.json({ captured: true, segment: null }); return; }
  const segment = await appendSegment(seat, round.id, {
    kind: 'SPEECH', offsetMs: timingBody.offsetMs, durationMs: timingBody.durationMs, text: trimmed.slice(0, MAX_SEGMENT_CHARS), source: sttCapability().provider,
  });
  res.status(201).json({ captured: true, segment: { index: segment.index, offsetMs: segment.offsetMs } });
}));

/**
 * A device saying it is still capturing.
 *
 * The room sends this between one stretch of speech and the next, so silence in
 * the meeting is not mistaken for a tab that was closed. It writes nothing but
 * the timestamp, and it is gated exactly as sending audio is: only somebody who
 * agreed and was admitted can claim the round is being heard.
 */
observerRouter.post('/rounds/:roundId/heartbeat', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  const seat = await assertCapturing(req.auth!, round, party);
  await heardFrom(seat.observation.id);
  res.status(204).end();
}));

// The room's own microphone or recogniser failed for a stretch.
observerRouter.post('/rounds/:roundId/capture-gap', IN_THE_ROOM, asyncHandler(async (req, res) => {
  const body = gapSchema.parse(req.body);
  const { round, party } = await loadSeat(req.auth!, req.params.roundId);
  const seat = await assertCapturing(req.auth!, round, party);
  await appendSegment(seat, round.id, { kind: 'GAP', offsetMs: body.offsetMs, durationMs: body.durationMs, text: '', source: body.reason || 'client' });
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
