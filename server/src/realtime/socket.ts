import type { Server as HttpServer } from 'node:http';
import { Server, type Socket, type DefaultEventsMap } from 'socket.io';
import { CorruptRecordError, prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { verifyToken } from '../services/auth.js';
import { assertCanAccessSession, capabilitiesOf } from '../services/access.js';
import { consume } from '../middleware/rateLimit.js';
import { findInvitationByToken } from '../services/invitations.js';
import { LIVE_INTERVIEW_STATES, mayObserveLive } from '../services/observerPolicy.js';
import { startInterview, submitCandidateTurn, finalizeInterview, withdrawInterview, INVITATION_CONSUMED } from './interviewEngine.js';
import { sttCapability, ttsCapability } from '../providers/speech.js';
import { HttpError } from '../middleware/index.js';
import { isDraining, SERVER_RESTARTING_MESSAGE } from '../services/drainState.js';
import { beginRequest, holdCandidateSocket, UNDER_WAY_STATES } from './liveSessions.js';

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

/**
 * What a staff socket is asking to do. Observing a session is reading its
 * transcript as it is spoken; driving it is starting or finalising it. The
 * HTTP routes gate these differently and so does the socket.
 */
export type SocketIntent = 'observe' | 'drive';

// Turns written here become the transcript the evaluator scores and a human
// reads, so a failure must never hint at what exists. Denials are
// indistinguishable from "no such session" and internal faults never carry the
// underlying Prisma/engine text to the client.
const DENIED = 'Session not found';
const FAILED = 'Unable to complete request';
const SLOW_DOWN = 'Too many requests';

// Per session, per minute. The HTTP room has per-invitation limiters in app.ts;
// the socket, the primary transport, had none, so a candidate's browser could
// fire turns as fast as it liked against a route that funds a model call each.
const SOCKET_WINDOW_MS = 60_000;
const SOCKET_LIMITS = { start: 5, candidate_turn: 30, finalize: 5 } as const;
async function withinLimit(event: keyof typeof SOCKET_LIMITS, sessionId: string): Promise<boolean> {
  if (config.nodeEnv === 'test') return true;
  return (await consume(`socket-${event}`, sessionId, SOCKET_WINDOW_MS, SOCKET_LIMITS[event])).allowed;
}

/**
 * Why a draining process turns this join away, or null to let it in.
 *
 * Only candidates are refused, and only for interviews not yet under way:
 * staff observing keeps nothing alive for the drain, and a candidate mid-
 * interview must be able to reconnect after a network blip.
 */
export function drainRefusal(draining: boolean, authKind: SocketAuth['kind'], state: string): string | null {
  if (!draining || authKind !== 'candidate' || UNDER_WAY_STATES.includes(state)) return null;
  return SERVER_RESTARTING_MESSAGE;
}

/** The candidate-facing refusal for a start on a draining process, if that is what failed. */
function restartingMessage(err: unknown): string | null {
  return err instanceof HttpError && err.status === 503 && err.message === SERVER_RESTARTING_MESSAGE ? err.message : null;
}

/** Count a socket event as in-flight work for the drain while it runs. */
function tracked<A extends unknown[]>(handler: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const done = beginRequest();
    try {
      await handler(...args);
    } finally {
      done();
    }
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Log fields for a failed socket event. A corrupt record is named by model, id
 * and field so it can be found and repaired; its content is never logged.
 */
export function socketFailureLog(err: unknown): { err: string; model?: string; id?: string; field?: string } {
  return err instanceof CorruptRecordError ? { err: err.message, ...err.record } : { err: describe(err) };
}

/**
 * Expiry is evaluated exactly as the portal's `loadByToken`: a null `expiresAt`
 * never expires, anything already past is dead.
 */
async function loadInvitation(token: string) {
  const inv = await findInvitationByToken(token, (tokenHash) => prisma.invitation.findUnique({
    where: { tokenHash },
    include: { session: { select: { id: true, tenantId: true, state: true } } },
  }));
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
 *
 * For staff this is the same three questions the HTTP routes ask, in the same
 * order: may this person read candidates at all (capability), may they read
 * THIS candidate (object scope, via assertCanAccessSession), and if the
 * candidate may be on the call right now, were they told someone might be
 * watching (the observer-consent gate)? It used to ask only whether the tenant
 * matched, which let any user of the tenant sit in on any live interview and
 * force any session to be assessed.
 */
export async function authorizeSession(
  auth: SocketAuth,
  requestedSessionId: string | undefined,
  intent: SocketIntent,
): Promise<AuthorizedSession | null> {
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

  const capabilities = capabilitiesOf(claims.role);
  const needed = intent === 'drive' ? 'interview:drive' : 'candidate:read';
  if (!capabilities.includes(needed)) return null;

  let session: { id: string; state: string; consentJson: string };
  try {
    session = await assertCanAccessSession(claims, requestedSessionId);
  } catch {
    // assertCanAccessSession answers "not found" for both a missing session and
    // one outside the caller's scope; the socket says the same thing.
    return null;
  }

  if (intent === 'observe' && LIVE_INTERVIEW_STATES.has(session.state) && !(await mayObserveLive(session))) {
    return null;
  }
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

    // A candidate's open socket is an interview the shutdown drain waits for;
    // whether it is still live is the session state's call, not this one's.
    if (socket.data.auth.kind === 'candidate') {
      socket.once('disconnect', holdCandidateSocket(socket.data.auth.sessionId));
    }

    const targetOf = (requested?: string): string | undefined => requested ?? joinedSessionId ?? undefined;

    socket.on('join', tracked(async (payload: { sessionId?: string } | undefined, ack?: (r: unknown) => void) => {
      try {
        const session = await authorizeSession(socket.data.auth, payload?.sessionId, 'observe');
        if (!session) { ack?.({ error: DENIED }); return; }
        const refusal = drainRefusal(isDraining(), socket.data.auth.kind, session.state);
        if (refusal) { ack?.({ error: refusal, retryable: true }); return; }
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
    }));

    socket.on('start', tracked(async (payload: { sessionId?: string } | undefined, ack?: (r: unknown) => void) => {
      try {
        const session = await authorizeSession(socket.data.auth, targetOf(payload?.sessionId), 'drive');
        if (!session) { ack?.({ error: DENIED }); return; }
        if (!await withinLimit('start', session.id)) { ack?.({ error: SLOW_DOWN }); return; }
        const turn = await startInterview(session.id);
        io.to(session.id).emit('agent_turn', turn);
        ack?.({ ok: true });
      } catch (err) {
        const restarting = restartingMessage(err);
        if (restarting) { ack?.({ error: restarting, retryable: true }); return; }
        logger.error(socketFailureLog(err), 'start failed');
        ack?.({ error: FAILED });
      }
    }));

    socket.on('candidate_turn', tracked(async (payload: { text: string; sessionId?: string; startMs?: number; endMs?: number; confidence?: number }, ack?: (r: unknown) => void) => {
      try {
        const session = await authorizeSession(socket.data.auth, targetOf(payload?.sessionId), 'observe');
        if (!session) { ack?.({ error: DENIED }); return; }
        // Only the candidate may add to their own transcript. A recruiter with a
        // valid tenant JWT could otherwise inject text that feeds the evaluator
        // and the report a human reads — evidence tampering behind a hiring
        // decision. Recruiter preview uses the invitation token (/room/:token),
        // so it authenticates as the candidate and is unaffected.
        if (socket.data.auth?.kind !== 'candidate') { ack?.({ error: DENIED }); return; }
        if (!payload?.text?.trim()) { ack?.({ error: 'empty' }); return; }
        if (!await withinLimit('candidate_turn', session.id)) { ack?.({ error: SLOW_DOWN }); return; }
        const turn = await submitCandidateTurn(session.id, payload.text, payload);
        // Echoed to observers only now, once the words are in the transcript. An
        // echo before the write showed observers an answer the engine then
        // rejected, which the evaluator never saw and the reviewer never read.
        socket.to(session.id).emit('candidate_turn', { text: payload.text });
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
        logger.error(socketFailureLog(err), 'candidate_turn failed');
        ack?.({ error: FAILED });
      }
    }));

    socket.on('finalize', tracked(async (payload: { sessionId?: string } | undefined, ack?: (r: unknown) => void) => {
      try {
        const session = await authorizeSession(socket.data.auth, targetOf(payload?.sessionId), 'drive');
        if (!session) { ack?.({ error: DENIED }); return; }
        // Candidates must not be able to force assessment. Otherwise they could
        // connect, start, and immediately finalise — skipping the interview and
        // producing an assessment from no evidence that HR would read as a
        // system-generated result. Finalisation happens automatically when the
        // interviewer signs off, or is driven by a recruiter.
        if (socket.data.auth?.kind !== 'user') { ack?.({ error: DENIED }); return; }
        if (!await withinLimit('finalize', session.id)) { ack?.({ error: SLOW_DOWN }); return; }
        const { assessmentId } = await finalizeInterview(session.id);
        io.to(session.id).emit('assessment_ready', { assessmentId });
        ack?.({ ok: true, assessmentId });
      } catch (err) {
        logger.error(socketFailureLog(err), 'finalize failed');
        ack?.({ error: FAILED });
      }
    }));
  });

  return io;
}
