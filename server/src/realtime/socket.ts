import type { Server as HttpServer } from 'node:http';
import { Server, type Socket, type DefaultEventsMap } from 'socket.io';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { verifyToken } from '../services/auth.js';
import { startInterview, submitCandidateTurn, finalizeInterview, withdrawInterview, INVITATION_CONSUMED } from './interviewEngine.js';
import { sttCapability, ttsCapability } from '../providers/speech.js';

// The credential is kept after the handshake, not just the identity it proved:
// a socket can stay open for days, outliving the 12h recruiter JWT, and an
// invitation can expire or be revoked while the interview is in progress. Every
// event re-checks the credential rather than trusting the connection.
type SocketAuth =
  | { kind: 'user'; tenantId: string; token: string }
  | { kind: 'candidate'; tenantId: string; sessionId: string; token: string };

interface InterviewSocketData {
  auth: SocketAuth;
}

type InterviewSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, InterviewSocketData>;

interface AuthorizedSession {
  id: string;
  state: string;
}

// Turns written here become the transcript the evaluator scores and a human
// reads, so a failure must never hint at what exists. Denials are
// indistinguishable from "no such session" and internal faults never carry the
// underlying Prisma/engine text to the client.
const DENIED = 'Session not found';
const FAILED = 'Unable to complete request';

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Expiry is evaluated exactly as the portal's `loadByToken`: a null `expiresAt`
 * never expires, anything already past is dead.
 */
async function loadInvitation(token: string) {
  const inv = await prisma.invitation.findUnique({
    where: { token },
    include: { session: { select: { id: true, tenantId: true, state: true } } },
  });
  if (!inv) return null;
  if (inv.expiresAt && inv.expiresAt < new Date()) return null;
  // A consumed invitation must not authenticate. Checking only existence and
  // expiry let a finished interview be reopened over the socket: the credential
  // still resolved, and `start` would then converge the session back to live.
  if (inv.status === INVITATION_CONSUMED) return null;
  return inv;
}

async function resolveHandshakeAuth(raw: Record<string, unknown>): Promise<SocketAuth | null> {
  // Handshake auth payload only — never the query string, which leaks live
  // credentials into access logs and proxy logs (see middleware/authenticate).
  const bearer = typeof raw.token === 'string' ? raw.token : undefined;
  if (bearer) {
    const claims = verifyToken(bearer);
    if (claims) return { kind: 'user', tenantId: claims.tenantId, token: bearer };
  }

  const invitationToken = typeof raw.invitationToken === 'string' ? raw.invitationToken : undefined;
  if (invitationToken) {
    const inv = await loadInvitation(invitationToken);
    if (inv) {
      return { kind: 'candidate', tenantId: inv.session.tenantId, sessionId: inv.sessionId, token: invitationToken };
    }
  }

  return null;
}

/**
 * Single authorisation gate for every event. Session ids are cuids that appear
 * in ordinary API responses, so possession of one proves nothing — the caller's
 * own credential decides which session they may touch.
 */
async function authorizeSession(auth: SocketAuth, requestedSessionId?: string): Promise<AuthorizedSession | null> {
  if (auth.kind === 'candidate') {
    const inv = await loadInvitation(auth.token);
    if (!inv) return null;
    // The invitation, not the client, names the session. A re-pointed token
    // must not carry over access granted at connection time.
    if (inv.sessionId !== auth.sessionId) return null;
    if (requestedSessionId && requestedSessionId !== inv.sessionId) return null;
    return { id: inv.sessionId, state: inv.session.state };
  }

  const claims = verifyToken(auth.token);
  if (!claims) return null;
  if (!requestedSessionId) return null;
  const session = await prisma.interviewSession.findUnique({
    where: { id: requestedSessionId },
    select: { id: true, tenantId: true, state: true },
  });
  if (!session || session.tenantId !== claims.tenantId) return null;
  return { id: session.id, state: session.state };
}

export function attachInterviewSocket(httpServer: HttpServer): Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, InterviewSocketData> {
  const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, InterviewSocketData>(httpServer, {
    cors: { origin: config.webOrigin, methods: ['GET', 'POST'] },
  });

  // Authenticate before any handler is registered, so an anonymous socket can
  // never reach an event at all.
  io.use((socket, next) => {
    const raw = socket.handshake.auth as Record<string, unknown>;
    resolveHandshakeAuth(raw)
      .then((auth) => {
        if (!auth) return next(new Error('Unauthorized'));
        socket.data.auth = auth;
        next();
      })
      .catch((err: unknown) => {
        logger.error({ err: describe(err) }, 'socket authentication failed');
        next(new Error('Unauthorized'));
      });
  });

  io.on('connection', (socket: InterviewSocket) => {
    // Convenience only: recruiters need not resend the id on every event. It is
    // an input to authorisation, never a substitute for it.
    let joinedSessionId: string | null = null;

    const targetOf = (requested?: string): string | undefined => requested ?? joinedSessionId ?? undefined;

    socket.on('join', async (payload: { sessionId?: string } | undefined, ack?: (r: unknown) => void) => {
      try {
        const session = await authorizeSession(socket.data.auth, payload?.sessionId);
        if (!session) { ack?.({ error: DENIED }); return; }
        joinedSessionId = session.id;
        socket.join(session.id);
        ack?.({
          ok: true,
          sessionId: session.id,
          state: session.state,
          speech: { stt: sttCapability(), tts: ttsCapability() },
        });
      } catch (err) {
        logger.error({ err: describe(err) }, 'socket join failed');
        ack?.({ error: FAILED });
      }
    });

    socket.on('start', async (payload: { sessionId?: string } | undefined, ack?: (r: unknown) => void) => {
      try {
        const session = await authorizeSession(socket.data.auth, targetOf(payload?.sessionId));
        if (!session) { ack?.({ error: DENIED }); return; }
        const turn = await startInterview(session.id);
        io.to(session.id).emit('agent_turn', turn);
        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: describe(err) }, 'start failed');
        ack?.({ error: FAILED });
      }
    });

    socket.on('candidate_turn', async (payload: { text: string; sessionId?: string; startMs?: number; endMs?: number; confidence?: number }, ack?: (r: unknown) => void) => {
      try {
        const session = await authorizeSession(socket.data.auth, targetOf(payload?.sessionId));
        if (!session) { ack?.({ error: DENIED }); return; }
        // Only the candidate may add to their own transcript. A recruiter with a
        // valid tenant JWT could otherwise inject text that feeds the evaluator
        // and the report a human reads — evidence tampering behind a hiring
        // decision. Recruiter preview uses the invitation token (/room/:token),
        // so it authenticates as the candidate and is unaffected.
        if (socket.data.auth?.kind !== 'candidate') { ack?.({ error: DENIED }); return; }
        if (!payload?.text?.trim()) { ack?.({ error: 'empty' }); return; }
        socket.to(session.id).emit('candidate_turn', { text: payload.text });
        const turn = await submitCandidateTurn(session.id, payload.text, payload);
        io.to(session.id).emit('agent_turn', turn);
        if (turn.withdrawn) {
          // Ended at the candidate's request — closed, never scored.
          await withdrawInterview(session.id, turn.kind === 'safety' ? 'safety_stop' : 'candidate_withdrew');
        } else if (turn.done) {
          const { assessmentId } = await finalizeInterview(session.id);
          io.to(session.id).emit('assessment_ready', { assessmentId });
        }
        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: describe(err) }, 'candidate_turn failed');
        ack?.({ error: FAILED });
      }
    });

    socket.on('finalize', async (payload: { sessionId?: string } | undefined, ack?: (r: unknown) => void) => {
      try {
        const session = await authorizeSession(socket.data.auth, targetOf(payload?.sessionId));
        if (!session) { ack?.({ error: DENIED }); return; }
        // Candidates must not be able to force assessment. Otherwise they could
        // connect, start, and immediately finalise — skipping the interview and
        // producing an assessment from no evidence that HR would read as a
        // system-generated result. Finalisation happens automatically when the
        // interviewer signs off, or is driven by a recruiter.
        if (socket.data.auth?.kind !== 'user') { ack?.({ error: DENIED }); return; }
        const { assessmentId } = await finalizeInterview(session.id);
        io.to(session.id).emit('assessment_ready', { assessmentId });
        ack?.({ ok: true, assessmentId });
      } catch (err) {
        logger.error({ err: describe(err) }, 'finalize failed');
        ack?.({ error: FAILED });
      }
    });
  });

  return io;
}
