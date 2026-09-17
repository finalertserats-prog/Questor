import express from 'express';
import type { Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { requestId, errorHandler, csrfProtection } from './middleware/index.js';
import { rateLimit } from './middleware/rateLimit.js';
import { resolveCommit } from './services/build.js';
import { orgsRouter } from './routes/orgs.js';
import { pipelinesRouter, rolePipelineRouter } from './routes/pipelines.js';
import { authRouter } from './routes/auth.js';
import { rolesRouter } from './routes/roles.js';
import { candidatesRouter } from './routes/candidates.js';
import { interviewsRouter } from './routes/interviews.js';
import { portalRouter } from './routes/portal.js';
import { feedbackRequestRouter } from './routes/feedbackRequest.js';
import { signupRouter, signupDecisionRouter } from './routes/signup.js';
import { assessmentsRouter } from './routes/assessments.js';
import { adminRouter } from './routes/admin.js';
import { dashboardRouter } from './routes/dashboard.js';
import { connectorsRouter } from './routes/connectors.js';
import { observerConsentRouter, observerRouter } from './routes/observer.js';


export function createApp() {
  const app = express();

  // Behind nginx, req.ip is the proxy's address for EVERY request unless this is
  // set — so every IP-keyed rate limit collapses into one shared bucket for the
  // whole internet. The login limiter (10 per 15 min) then locks out every
  // recruiter as soon as any ten failed logins occur anywhere. Deliberately `1`
  // and not `true`: trusting the whole chain lets a client forge
  // X-Forwarded-For and pick its own rate-limit bucket.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: config.webOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(requestId);

  // Before every router: cookie auth is ambient, so without a CSRF gate any
  // page a logged-in recruiter visits could drive state-changing calls into
  // Questor with their session. Exemptions (safe methods, the unauthenticated
  // portal, header-authenticated API clients) live in the middleware.
  app.use(csrfProtection);

  // `commit` answers "is production running the code I think it is?" in one
  // request. Without it, confirming a deploy meant an SSH session and a git log —
  // and reading a build timestamp against commit dates in the wrong timezone is
  // exactly how a 4-commit gap gets misread as 21.
  //
  // Read once at startup, never per request: this endpoint is what uptime checks
  // hit, and shelling out to git on every poll is a needless cost and a needless
  // failure mode.
  // The commit stays on the public health check on purpose: the deploy script
  // and the owner's "is production current?" question both read it without a
  // session. The security review rated the disclosure low; the resolver moved
  // to services/build.ts so the admin console can show the same value.
  const health = {
    status: 'ok',
    service: 'questor',
    commit: resolveCommit(),
  };
  app.get('/api/health', (_req, res) => res.json({ ...health, ts: new Date().toISOString() }));

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
  app.use('/api/portal/:token/integrity-event', rateLimit({ name: 'portal-integrity', windowMs: 60 * 60_000, max: 600, keyOf: portalKey }));
  // Integrity events have their own limiter above and must not also draw on this
  // shared budget: a candidate who switches tabs often (assistive technology
  // does exactly that) would otherwise be throttled out of their own interview.
  const isIntegrityEvent = (req: Request) => /^\/api\/portal\/[^/]+\/integrity-event(?:[/?]|$)/.test(req.originalUrl);
  app.use('/api/portal', rateLimit({ name: 'portal', windowMs: 15 * 60_000, max: 300, keyOf: portalKey, skip: isIntegrityEvent }));

  // "Would you like to speak to a person?", followed from a feedback email.
  // Keyed on IP rather than on the token, deliberately: the only threat here is
  // someone guessing tokens, and a per-token bucket would hand every guess its
  // own fresh allowance — which is no limit at all. The token is 256 bits, so
  // this is a bound on scanning rather than the thing standing in the way.
  app.use('/api/feedback-request', rateLimit({ name: 'feedback-request', windowMs: 15 * 60_000, max: 60 }), feedbackRequestRouter);

  // Signup is public, but approval links carry their own high-entropy token.
  // Mount decisions first so they get the 60-request token-scanning budget, not
  // the stricter submission budget.
  app.use('/api/signup/decision', rateLimit({ name: 'signup-decision', windowMs: 15 * 60_000, max: 60 }), signupDecisionRouter);
  app.use('/api/signup', rateLimit({ name: 'signup', windowMs: 15 * 60_000, max: 10 }), signupRouter);

  // The candidate's consent link for an AI observer on a human round. Public
  // and token-gated like the feedback link, and keyed on IP for the same
  // reason: the only abuse is guessing tokens.
  app.use('/api/observer-consent', rateLimit({ name: 'observer-consent', windowMs: 15 * 60_000, max: 60 }), observerConsentRouter);
  // The observer room uploads a chunk of the round every ~30 seconds and each
  // one can be a billed transcription, so the ceiling is a few hours of rounds
  // per hour per address: slack for real use, a bound on a runaway client.
  app.use('/api/observer/rounds/:roundId/segments', rateLimit({ name: 'observer-segments', windowMs: 60 * 60_000, max: 600 }));

  // Public organisation lookup for sign-in links. A person follows a link once
  // or twice; 30 per 15 minutes per IP stops anyone guessing slugs at speed.
  //
  // The name search (GET /api/orgs?q=) is a different shape of traffic: the
  // sign-in box calls it as someone types, so one honest attempt is a dozen
  // requests even after debouncing, and sharing the slug window would lock a
  // person out of signing in for typing their employer's name twice. It gets
  // its own window. 120 still caps a harvesting run at a few hundred prefixes
  // an hour from one address, against a search that needs three letters and
  // answers eight names at most.
  const isOrgSearch = (req: express.Request) => req.path === '/' || req.path === '';
  app.use(
    '/api/orgs',
    rateLimit({ name: 'orgs', windowMs: 15 * 60_000, max: 30, skip: isOrgSearch }),
    rateLimit({ name: 'orgs-search', windowMs: 15 * 60_000, max: 120, skip: (req) => !isOrgSearch(req) }),
    orgsRouter,
  );
  app.use('/api/auth', authRouter);
  app.use('/api/roles', rolesRouter);
  app.use('/api/roles', rolePipelineRouter);
  app.use('/api/candidates', candidatesRouter);
  app.use('/api/interviews', interviewsRouter);
  app.use('/api/pipelines', pipelinesRouter);
  app.use('/api/observer', observerRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api/assessments', assessmentsRouter);
  app.use('/api/admin/connectors', connectorsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use(errorHandler);
  return app;
}
