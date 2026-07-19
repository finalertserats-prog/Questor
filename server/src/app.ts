import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { requestId, errorHandler } from './middleware/index.js';
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
