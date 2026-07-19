import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { requestId, errorHandler } from './middleware/index.js';
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

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'questor', ts: new Date().toISOString() }));

  // Credential stuffing / brute force on the recruiter login.
  app.use('/api/auth/login', rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 10 }));
  app.use('/api/auth', rateLimit({ name: 'auth', windowMs: 15 * 60_000, max: 60 }));

  // The candidate portal is unauthenticated and every answer triggers a paid
  // LLM call, so it is both the abuse surface and the cost-amplification path.
  // Key on the invitation token where present so one candidate cannot exhaust
  // the budget, and so several candidates behind one office NAT are not
  // throttled as a single client.
  const portalKey = (req: { params: Record<string, string>; ip?: string }) => req.params.token ?? req.ip ?? 'unknown';
  app.use('/api/portal/:token/turn', rateLimit({ name: 'portal-turn', windowMs: 60 * 60_000, max: 120, keyOf: portalKey as never }));
  app.use('/api/portal', rateLimit({ name: 'portal', windowMs: 15 * 60_000, max: 300, keyOf: portalKey as never }));

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
