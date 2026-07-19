import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { startInterview, submitCandidateTurn, finalizeInterview } from './interviewEngine.js';
import { sttCapability, ttsCapability } from '../providers/speech.js';

export function attachInterviewSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: config.webOrigin, methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    let sessionId: string | null = null;

    socket.on('join', async (payload: { sessionId?: string; token?: string }, ack?: (r: unknown) => void) => {
      try {
        let session = null;
        if (payload.token) {
          const inv = await prisma.invitation.findUnique({ where: { token: payload.token }, include: { session: true } });
          session = inv?.session ?? null;
        } else if (payload.sessionId) {
          session = await prisma.interviewSession.findUnique({ where: { id: payload.sessionId } });
        }
        if (!session) { ack?.({ error: 'Session not found' }); return; }
        sessionId = session.id;
        socket.join(session.id);
        ack?.({
          ok: true,
          sessionId: session.id,
          state: session.state,
          speech: { stt: sttCapability(), tts: ttsCapability() },
        });
      } catch (err) {
        logger.error({ err: String(err) }, 'socket join failed');
        ack?.({ error: 'join failed' });
      }
    });

    socket.on('start', async (_p, ack?: (r: unknown) => void) => {
      if (!sessionId) return ack?.({ error: 'not joined' });
      try {
        const turn = await startInterview(sessionId);
        io.to(sessionId).emit('agent_turn', turn);
        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: String(err) }, 'start failed');
        ack?.({ error: String(err) });
      }
    });

    socket.on('candidate_turn', async (payload: { text: string; startMs?: number; endMs?: number; confidence?: number }, ack?: (r: unknown) => void) => {
      if (!sessionId) return ack?.({ error: 'not joined' });
      if (!payload?.text?.trim()) return ack?.({ error: 'empty' });
      try {
        socket.to(sessionId).emit('candidate_turn', { text: payload.text });
        const turn = await submitCandidateTurn(sessionId, payload.text, payload);
        io.to(sessionId).emit('agent_turn', turn);
        if (turn.done) {
          const { assessmentId } = await finalizeInterview(sessionId);
          io.to(sessionId).emit('assessment_ready', { assessmentId });
        }
        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: String(err) }, 'candidate_turn failed');
        ack?.({ error: String(err) });
      }
    });

    socket.on('finalize', async (_p, ack?: (r: unknown) => void) => {
      if (!sessionId) return ack?.({ error: 'not joined' });
      try {
        const { assessmentId } = await finalizeInterview(sessionId);
        io.to(sessionId).emit('assessment_ready', { assessmentId });
        ack?.({ ok: true, assessmentId });
      } catch (err) {
        ack?.({ error: String(err) });
      }
    });
  });

  return io;
}
