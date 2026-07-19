import express from 'express';
import type { Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { requestId, errorHandler, csrfProtection } from './middleware/index.js';
import { rateLimit } from './middleware/rateLimit.js';
import { authRouter } from './routes/auth.js';
import { rolesRouter } from './routes/roles.js';
import { candidatesRouter } from './routes/candidates.js';
import { interviewsRouter } from './routes/interviews.js';
import { portalRouter } from './routes/portal.js';
import { assessmentsRouter } from './routes/assessments.js';
import { adminRouter } from './routes/admin.js';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: config.webOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(requestId);

  // Before every router: cookie auth is ambient, so without a CSRF gate any
  // page a logged-in recruiter visits could drive state-changing calls into
  // Questor with their session. Exemptions (safe methods, the unauthenticated
  // portal, header-authenticated API clients) live in the middleware.
  app.use(csrfProtection);

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'questor', ts: new Date().toISOString() }));

  // Credential stuffing / brute force on the recruiter login.
  app.use('/api/auth/login', rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 10 }));
  app.use('/api/auth', rateLimit({ name: 'auth', windowMs: 15 * 60_000, max: 60 }));

  // The candidate portal is unauthenticated and every answer triggers a paid
  // LLM call, so it is both the abuse surface and the cost-amplification path.
  // Key on the invitation token where present so one candidate cannot exhaust
  // the budget, and so several candidates behind one office NAT are not
  // throttled as a single client.
  // Derive the token from req.originalUrl rather than req.params or req.path.
  // req.params is not populated at a mount point. req.path is worse than it
  // looks: Express strips the entire matched mount prefix, so inside a limiter
  // mounted at '/api/portal/:token/turn' req.path is just '/' and the regex
  // below never matches — the key silently degraded to IP for exactly the two
  // routes that cost money, while working at the generic '/api/portal' mount.
  // That is the inverse of the bug this comment used to describe, and it meant
  // one token behind rotating IPs evaded its per-token ceiling entirely while a
  // NAT'd office shared a single bucket. originalUrl is never rewritten by
  // mounting, so it is the only stable source here.
  const portalKey = (req: Request) => {
    const m = /^\/api\/portal\/([A-Za-z0-9_-]{8,64})(?:[/?]|$)/.exec(req.originalUrl);
    return m ? `t:${m[1]}` : `ip:${req.ip ?? 'unknown'}`;
  };
  app.use('/api/portal/:token/turn', rateLimit({ name: 'portal-turn', windowMs: 60 * 60_000, max: 120, keyOf: portalKey }));
  // Server-side TTS is billed per synthesis. The route already refuses to speak
  // anything but an agent turn persisted for that session, so this is the
  // second bound rather than the first: it caps how hard one token can hammer
  // the vendor by re-requesting the same handful of questions. An interview has
  // tens of agent turns, and repeats are served from cache, so 200/hour is
  // slack for a real candidate and a ceiling for a script.
  app.use('/api/portal/:token/speak', rateLimit({ name: 'portal-speak', windowMs: 60 * 60_000, max: 200, keyOf: portalKey }));
  // Stricter than every sibling, because this is the worst case in the app:
  // unauthenticated, billed per MINUTE OF AUDIO rather than per call, and with
  // no server-authored artefact to validate the payload against — a 10 MB clip
  // costs real money on its own. A candidate speaks tens of answers in an
  // interview and each upload is one answer, so 60/hour covers a real session
  // with retries and still caps a script at a bounded hourly spend.
  app.use('/api/portal/:token/transcribe', rateLimit({ name: 'portal-transcribe', windowMs: 60 * 60_000, max: 60, keyOf: portalKey }));
  app.use('/api/portal', rateLimit({ name: 'portal', windowMs: 15 * 60_000, max: 300, keyOf: portalKey }));

  app.use('/api/auth', authRouter);
  app.use('/api/roles', rolesRouter);
  app.use('/api/candidates', candidatesRouter);
  app.use('/api/interviews', interviewsRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api/assessments', assessmentsRouter);
  app.use('/api/admin', adminRouter);

  app.use(errorHandler);
  return app;
}
