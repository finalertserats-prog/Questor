import express from 'express';
import type { Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { prisma } from './db.js';
import { requestId, errorHandler, csrfProtection, authenticate, rejectNulBytes, HttpError } from './middleware/index.js';
import { failureRateLimit, rateLimit, LOGIN_FAILURES_PER_ACCOUNT, LOGIN_FAILURES_PER_ADDRESS, LOGIN_WINDOW_MS } from './middleware/rateLimit.js';
import { resolveCommit } from './services/build.js';
import { isDraining } from './services/drainState.js';
import { probeDatabase } from './services/databaseProbe.js';
import { llmHealthSummary } from './providers/llm/index.js';
import { beginRequest } from './realtime/liveSessions.js';
import { orgsRouter } from './routes/orgs.js';
import { pipelinesRouter, rolePipelineRouter } from './routes/pipelines.js';
import { roundMeetingsRouter } from './routes/roundMeetings.js';
import { authRouter } from './routes/auth.js';
import { rolesRouter } from './routes/roles.js';
import { roleStatusRouter } from './routes/roleStatus.js';
import { roleImportRouter } from './routes/roleImport.js';
import { catalogRouter } from './routes/catalog.js';
import { catalogReviewRouter } from './routes/catalogReview.js';
import { jdDraftsRouter } from './routes/jdDrafts.js';
import { fieldDraftsRouter } from './routes/fieldDrafts.js';
import { candidatesRouter } from './routes/candidates.js';
import { candidateImportsRouter } from './routes/candidateImports.js';
import { interviewsRouter } from './routes/interviews.js';
import { interviewersRouter } from './routes/interviewers.js';
import { portalRouter } from './routes/portal.js';
import { feedbackRequestRouter } from './routes/feedbackRequest.js';
import { feedbackConsentRouter } from './routes/feedbackConsent.js';
import { signupRouter, signupDecisionRouter } from './routes/signup.js';
import { demoRouter, demoDecisionRouter } from './routes/demo.js';
import { DEMO_READ_ONLY_MESSAGE } from './services/demoPolicy.js';
import { demoInterviewRouter, demoFeedbackRouter } from './routes/demoInterview.js';
import { demoFeedbackAdminRouter } from './routes/demoFeedbackAdmin.js';
import { assessmentsRouter } from './routes/assessments.js';
import { adminRouter } from './routes/admin.js';
import { calibrationRouter } from './routes/calibration.js';
import { systemHealthRouter } from './routes/systemHealth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { reportsRouter } from './routes/reports.js';
import { connectorsRouter } from './routes/connectors.js';
import { atsConnectionRouter } from './routes/atsConnection.js';
import { candidateAtsRouter } from './routes/candidateAts.js';
import { observerConsentRouter, observerRouter } from './routes/observer.js';
import { libraryRouter, libraryStatusRouter } from './routes/library.js';
import { libraryAdminRouter } from './routes/libraryAdmin.js';


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
  // A NUL inside a JSON string is valid JSON — `"a\u0000b"` parses — and then
  // reaches Postgres, which refuses it. The caller was answered 500 with a
  // ConnectorError in the log, so anyone could produce a server error, and a
  // log line, with one byte (docs/qa/resilience-2026-09-23.md, R22). Refused
  // here it is what it actually is: a bad request, with a message a person can
  // act on. Checked after parsing rather than on the raw bytes, because the
  // escape sequence is what survives and the raw byte is a parse error anyway.
  app.use(rejectNulBytes);
  app.use(requestId);
  // The shutdown drain waits for these: a candidate's answer whose model call
  // is still running must get its reply before the process exits.
  app.use((_req, res, next) => {
    const done = beginRequest();
    res.once('finish', done);
    res.once('close', done);
    next();
  });

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
  // `draining` lets a deploy tell the old process, finishing its interviews,
  // from the new one. Status stays "ok" while draining: the process is still
  // serving the interviews in progress, and it is not down.
  //
  // `database` is what makes "ok" mean the app works: a process that cannot
  // reach its database answers 503 "unavailable", so uptime checks and the
  // deploy's verify step both see the outage (2026-09-18: 15 minutes of failed
  // sign-ins behind a green health check).
  app.get('/api/health', async (_req, res) => {
    const databaseUp = await probeDatabase();
    res.status(databaseUp ? 200 : 503).json({
      ...health,
      status: databaseUp ? 'ok' : 'unavailable',
      database: databaseUp ? 'ok' : 'unreachable',
      draining: isDraining(),
      // Which model layer is serving interviews (primary, local fallback or
      // built-in writer). This route is public, so only the layer is shown;
      // provider, cooldown and failure class live on admin System health.
      llm: { layer: llmHealthSummary().layer },
      ts: new Date().toISOString(),
    });
  });

  // Credential stuffing / brute force on the recruiter login.
  //
  // Charges FAILURES, not requests, and the tight bucket is per ACCOUNT. The
  // previous limiter consumed before the handler and keyed on the client
  // address, so ten SUCCESSFUL sign-ins from one office exhausted it and the
  // eleventh colleague that quarter-hour was told "Too many requests"
  // (docs/qa/resilience-2026-09-23.md, S1). A looser address ceiling remains
  // for one address working through many accounts.
  app.use('/api/auth/login', failureRateLimit({
    name: 'login',
    windowMs: LOGIN_WINDOW_MS,
    max: LOGIN_FAILURES_PER_ACCOUNT,
    addressMax: LOGIN_FAILURES_PER_ADDRESS,
    // Normalised, so "A@x" and "a@x" share one bucket. Hashing happens in the
    // store and in the log line; nothing here writes an address anywhere.
    subjectOf: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' && email.trim() ? `account:${email.trim().toLowerCase()}` : null;
    },
    failClosed: true,
  }));
  // Registration takes a credential too, and nothing about it is per-account:
  // the account does not exist yet. So it keeps the plain per-address limiter.
  //
  // Login no longer draws on this one. It counted every request, successes
  // included, which is the same defect as S1 at a looser threshold — 60
  // sign-ins from one office in a quarter-hour is reachable on a Monday
  // morning. The failure limiter above carries login's address ceiling now,
  // and charges only what failed.
  //
  // Mounted on all of /api/auth this also counted GET /me, which the web calls
  // on every page load, so a few HR users behind one office address exhausted
  // it in minutes and every page answered "Too many requests". /me and
  // /tour/complete are authenticated; /logout only clears cookies the caller
  // already holds.
  app.use('/api/auth/register', rateLimit({ name: 'auth', windowMs: 15 * 60_000, max: 60, failClosed: true }));

  // The code step. Its own budget, because it is a different guess: the code
  // is six digits, and the per-challenge attempt limit in the database is the
  // real bound. This one stops a script working through challenges rather than
  // through one challenge's five tries. Fails closed, like the password step.
  app.use('/api/auth/code', rateLimit({ name: 'login-code', windowMs: 15 * 60_000, max: 30, failClosed: true }));

  // Password recovery. Its own limiters rather than a share of the sign-in
  // budget: a person who cannot sign in must not find that their failed
  // attempts have also used up the way to recover.
  //
  // Two buckets, because the two abuses are different shapes. Per ADDRESS stops
  // one mailbox being flooded from a botnet — the bucket that actually protects
  // the person, since an IP-keyed limit alone is worth nothing to an attacker
  // with a thousand addresses to send from. Per IP stops one machine walking a
  // list of addresses to find which ones have accounts. Both fail closed: while
  // the counter store is unreachable this is an unmetered mail cannon aimed at
  // whoever the caller names, and an hour of "try again shortly" on a recovery
  // page is the cheaper of the two failures.
  //
  // The address is read from the parsed body (express.json is mounted above).
  // It is normalised so Person@x and person@x share a bucket, and only ever
  // appears inside the limiter key, which reaches the log as a fingerprint.
  const forgotAddressKey = (req: Request) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    return email ? `e:${email}` : `ip:${req.ip ?? 'unknown'}`;
  };
  app.use('/api/auth/password/forgot', rateLimit({ name: 'password-forgot-address', windowMs: 60 * 60_000, max: 5, keyOf: forgotAddressKey, failClosed: true }));
  app.use('/api/auth/password/forgot', rateLimit({ name: 'password-forgot-ip', windowMs: 60 * 60_000, max: 20, failClosed: true }));
  // Following a link is not guessing a password, but a token IS guessable in
  // principle, so the attempts are bounded. 30 an hour against 256 bits is a
  // formality; it is here so the ceiling exists rather than because anyone
  // could reach it.
  //
  // `/reset/check` gets its own budget rather than sharing this one. The page
  // calls it on every mount, so one honest recovery costs two of the thirty —
  // and behind an office NAT fifteen recoveries an hour would then close the
  // recovery path for everybody on that address, which is the exact failure
  // the sign-in limiter above already had to be rescued from once. It is also
  // the cheaper oracle of the two, so it gets the looser number, not the
  // shared one.
  const isResetCheck = (req: Request) => /^\/api\/auth\/password\/reset\/check(?:[/?]|$)/.test(req.originalUrl);
  app.use('/api/auth/password/reset', rateLimit({ name: 'password-reset', windowMs: 60 * 60_000, max: 30, failClosed: true, skip: isResetCheck }));
  app.use('/api/auth/password/reset/check', rateLimit({ name: 'password-reset-check', windowMs: 60 * 60_000, max: 120, failClosed: true }));
  // Changing your own password is limited in routes/auth.ts instead, where it
  // can sit after `authenticate` and key on the user. Mounted here it would run
  // before the session is resolved, fall back to the IP, and throttle a whole
  // NAT'd office as one caller — the exact failure the sign-in limiter above
  // already had to be rescued from.

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
  // Continue produces a reply exactly as an answer does, so it spends from the
  // same bucket rather than doubling what one token can spend.
  app.use(['/api/portal/:token/turn', '/api/portal/:token/continue'], rateLimit({ name: 'portal-turn', windowMs: 60 * 60_000, max: 120, keyOf: portalKey }));
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
  // Sending mails the candidate and verifying is a guess, so both are bounded
  // per invitation on top of the per-code attempt limit in the database.
  app.use('/api/portal/:token/identity', rateLimit({ name: 'portal-identity', windowMs: 15 * 60_000, max: 30, keyOf: portalKey }));
  app.use('/api/portal/:token/integrity-event', rateLimit({ name: 'portal-integrity', windowMs: 60 * 60_000, max: 600, keyOf: portalKey }));
  // The status page after the interview. It is a page someone leaves open and
  // refreshes while they wait, so the limit is generous — but it is still a
  // limit, because this link outlives the interview and is the one candidate
  // route with no natural end. Asking to speak to a person is bounded far
  // harder: it is idempotent, so a real person needs it once.
  app.use('/api/portal/:token/status', rateLimit({ name: 'portal-status', windowMs: 15 * 60_000, max: 120, keyOf: portalKey }));
  app.use('/api/portal/:token/talk-to-a-person', rateLimit({ name: 'portal-talk', windowMs: 60 * 60_000, max: 20, keyOf: portalKey }));
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
  // "Would you like written feedback?", followed from a recruiter's request.
  // Same token scheme and the same reasoning for an IP-keyed budget.
  app.use('/api/feedback-consent', rateLimit({ name: 'feedback-consent', windowMs: 15 * 60_000, max: 60 }), feedbackConsentRouter);
  // "Send feedback now" and its preview each email a candidate or may call a
  // paid model. The send is idempotent on its own; this bounds how often the
  // preview can be asked to generate.
  app.use(
    ['/api/assessments/:id/feedback-email/preview', '/api/assessments/:id/feedback-email/send'],
    rateLimit({ name: 'feedback-email', windowMs: 15 * 60_000, max: 30 }),
  );

  // Signup is public, but approval links carry their own high-entropy token.
  // Mount decisions first so they get the 60-request token-scanning budget, not
  // the stricter submission budget.
  app.use('/api/signup/decision', rateLimit({ name: 'signup-decision', windowMs: 15 * 60_000, max: 60, failClosed: true }), signupDecisionRouter);
  // The onboarding form's own lists — regions, business areas, size bands —
  // on their own budget, before the submission one. They shared the submission
  // limiter at first, which meant ten page loads in a quarter of an hour left
  // the form with empty dropdowns and no way to say why: a visitor who read
  // the page, went away and came back had spent the allowance meant for
  // requests. They write nothing, name nobody, and are the same three curated
  // lists for everyone, so they are limited like a public read.
  const isSignupOptions = (req: Request) => req.path === '/options';
  app.use('/api/signup', rateLimit({ name: 'signup-options', windowMs: 15 * 60_000, max: 120, skip: (req) => !isSignupOptions(req) }));
  app.use('/api/signup', rateLimit({ name: 'signup', windowMs: 15 * 60_000, max: 10, failClosed: true, skip: isSignupOptions }), signupRouter);
  app.use('/api/demo/decision', rateLimit({ name: 'demo-decision', windowMs: 15 * 60_000, max: 60, failClosed: true }), demoDecisionRouter);
  // Only the two public forms that build sandboxes or send email draw on this
  // budget. A signed-in demo's own calls (the sample interview, End demo) must
  // never be throttled by it: five an hour ended demos mid-tour.
  app.use(['/api/demo/request', '/api/demo/reaccess'], rateLimit({ name: 'demo', windowMs: 60 * 60_000, max: 5, failClosed: true }));
  app.use('/api/demo', demoRouter);
  // The demo interview and its feedback step, in their own router so this
  // lane and the guided-tour lane are not editing one file.
  app.use('/api/demo', demoInterviewRouter);
  // The feedback form itself runs SIGNED OUT: End demo clears the session
  // before it is reached, and the ticket in the link is its credential.
  app.use('/api/demo-feedback', demoFeedbackRouter);

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
  app.use('/api/catalog', catalogRouter);
  app.use('/api/catalog-review', catalogReviewRouter);
  app.use('/api/jd-drafts', jdDraftsRouter);
  // Every /suggest and /tidy is a model call, so an unbounded one is somebody
  // else's bill. Generous enough that a person writing a job advert never
  // meets it — each field asks once per visit — and low enough that a loop
  // does. Per user rather than per IP: a whole office behind one address must
  // not share one person's budget.
  // Every /suggest and /tidy is a model call, so an unbounded one is somebody
  // else's bill. Generous enough that a person writing a job advert never
  // meets it — each field asks once per visit — and low enough that a loop
  // does. Per user rather than per IP: a whole office behind one address must
  // not share one person's budget, which is why `authenticate` runs ahead of
  // the limiter rather than only inside the router.
  //
  // The two that call a model, and not /accepted. That one writes the record
  // that a draft was taken; it costs nothing to serve, and it is asked for
  // AFTER the model call it describes. Counting it would spend two units on
  // one call and, at the limit, throw away the audit for a draft the person
  // had already been given.
  app.use(['/api/drafts/suggest', '/api/drafts/tidy'], authenticate, rateLimit({
    name: 'field-drafts', windowMs: 60 * 60_000, max: 240,
    keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
  }));
  app.use('/api/drafts', fieldDraftsRouter);
  // Reads a JD out of an uploaded file; declared before rolesRouter, whose
  // /:id routes would otherwise claim /import-file.
  app.use('/api/roles', roleImportRouter);
  app.use('/api/roles', roleStatusRouter);
  app.use('/api/roles', rolesRouter);
  app.use('/api/roles', rolePipelineRouter);
  app.use('/api/candidates', candidateAtsRouter);
  app.use('/api/candidates', candidatesRouter);
  app.use('/api/candidate-imports', candidateImportsRouter);
  app.use('/api/interviews', interviewsRouter);
  app.use('/api/interviewers', interviewersRouter);
  // Before pipelinesRouter, whose GET /:id would otherwise claim /meeting-provider.
  app.use('/api/pipelines', roundMeetingsRouter);
  app.use('/api/pipelines', pipelinesRouter);
  app.use('/api/observer', observerRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api/assessments', assessmentsRouter);
  // The Q&A library is dark until LIBRARY_ENABLED is true: only /status
  // answers then. One switch mounts the owner's screen and the tenant read
  // API together; the worker has its own switch but is a separate process.
  app.use('/api/library', libraryStatusRouter);
  if (config.library.enabled) {
    app.use('/api/library/admin', libraryAdminRouter);
    app.use('/api/library', libraryRouter);
  }
  const blockDemoTenant = async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    try {
      if (!req.auth) { next(); return; }
      const tenant = await prisma.tenant.findUnique({ where: { id: req.auth.tenantId }, select: { isDemo: true } });
      if (tenant?.isDemo) throw new HttpError(403, DEMO_READ_ONLY_MESSAGE);
      next();
    } catch (err) { next(err); }
  };
  app.use('/api/admin', authenticate, blockDemoTenant);
  app.use('/api/admin/connectors', connectorsRouter);
  app.use('/api/admin/ats', atsConnectionRouter);
  // The console polls this every minute per open tab; the report is cached for
  // 15 s, and this bounds what a script can make the database do.
  app.use('/api/admin/health', rateLimit({ name: 'admin-health', windowMs: 60_000, max: 30 }), systemHealthRouter);
  app.use('/api/admin/calibration', calibrationRouter);
  // Platform-owner only, and mounted BEFORE the tenant admin router so its
  // own owner guard is the one that answers.
  app.use('/api/admin/demo-feedback', demoFeedbackAdminRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);

  app.use(errorHandler);
  return app;
}
