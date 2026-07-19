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
  // Derive the token from the path rather than req.params: at the '/api/portal'
  // mount point params are not populated, so a params-based key silently fell
  // back to IP for every route except /turn — throttling a whole office behind
  // one NAT as a single client.
  const portalKey = (req: Request) => {
    const m = /^\/([A-Za-z0-9_-]{8,64})(?:\/|$)/.exec(req.path);
    return m ? `t:${m[1]}` : `ip:${req.ip ?? 'unknown'}`;
  };
  app.use('/api/portal/:token/turn', rateLimit({ name: 'portal-turn', windowMs: 60 * 60_000, max: 120, keyOf: portalKey }));
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
