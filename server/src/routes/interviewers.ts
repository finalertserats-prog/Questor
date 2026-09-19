import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import { serverTtsReady, synthesizeServerSpeech, speechEtag } from '../providers/speech.js';
import { listActiveInterviewers, voiceForInterviewer, voiceHintForInterviewer } from '../services/interviewers.js';

/**
 * The AI interviewers HR can choose between, and a spoken sample of each.
 *
 * Only public fields leave this router: id, name, avatar, order. Which vendor
 * and which vendor voice speaks is backend configuration and is never sent to
 * an HR user or a candidate.
 */
export const interviewersRouter = Router();
interviewersRouter.use(authenticate);

interviewersRouter.get('/', requireCapability('interview:create'), asyncHandler(async (_req, res) => {
  res.json({ interviewers: await listActiveInterviewers() });
}));

/** The sample line. Built from the name only, so the cache holds one clip per voice. */
export function previewLine(name: string): string {
  return `Hi, I'm ${name}, an AI interviewer from Questor.`;
}

// Each miss is a paid synthesis. Keyed per user: everyone in an office shares an IP.
const previewLimit = rateLimit({ name: 'interviewer-preview', windowMs: 15 * 60_000, max: 30, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });

const previewParams = z.object({ id: z.string().regex(/^[a-z]{1,32}$/) });

/**
 * One interviewer's voice saying the sample line, synthesised exactly as the
 * live interview would be (same model, voice and delivery instruction), so
 * what HR hears is what the candidate hears.
 *
 * 204 when no server voice can speak — for the zero-key build and for demo
 * sandboxes, which never get paid speech — with the browser-voice hint in a
 * header so the page can pick a matching system voice instead.
 */
interviewersRouter.get('/:id/preview', requireCapability('interview:create'), previewLimit, asyncHandler(async (req, res) => {
  const { id } = previewParams.parse(req.params);
  const interviewer = await prisma.aIInterviewer.findFirst({ where: { id, active: true }, select: { id: true, name: true } });
  if (!interviewer) throw new HttpError(404, 'No such AI interviewer.');

  const text = previewLine(interviewer.name);
  res.setHeader('X-Preview-Text', encodeURIComponent(text));
  res.setHeader('X-Voice-Hint', await voiceHintForInterviewer(interviewer.id));
  res.setHeader('Access-Control-Expose-Headers', 'X-Preview-Text, X-Voice-Hint');

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { isDemo: true } });
  const voice = await voiceForInterviewer(interviewer.id);
  if (tenant?.isDemo || !serverTtsReady(voice)) return res.status(204).end();

  const etag = speechEtag(text, voice);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  let speech: Awaited<ReturnType<typeof synthesizeServerSpeech>>;
  try {
    speech = await synthesizeServerSpeech(text, voice);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), interviewerId: interviewer.id }, 'Preview TTS failed; falling back to browser speech');
    return res.status(204).end();
  }
  if (!speech) return res.status(204).end();
  res.setHeader('Content-Type', speech.contentType);
  res.setHeader('Content-Length', String(speech.audio.byteLength));
  return res.send(speech.audio);
}));
