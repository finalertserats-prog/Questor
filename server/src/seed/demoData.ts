import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { hashPassword } from '../services/auth.js';
import { assignRole, assignCandidate } from '../services/access.js';
import { extractRoleHeuristic } from '../engines/roleIntelligence.js';
import { normalizeProfile } from '../engines/resumeParser.js';
import { computeFitScore } from '../engines/fitScoring.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';

export const DEMO_JD = `Senior Data Engineer
Location: Bengaluru (Hybrid)  |  Employment type: Full-time  |  Level: Senior

About the role:
We are hiring a Senior Data Engineer to design and operate our analytical data platform. You will build and maintain reliable data pipelines, own our cloud data warehouse on Snowflake, and partner with analytics and product teams to deliver trustworthy data.

Responsibilities:
- Design robust, testable analytical data models and dimensional schemas.
- Build and operate batch and streaming pipelines using Python, Airflow, dbt and Spark.
- Own reliability of critical pipelines including detection, idempotent recovery and backfills.
- Architect cloud data platform on AWS for changing volume, cost and SLA.
- Write and optimize complex SQL; reason about performance, partitioning and correctness.
- Collaborate with analysts, product and engineering; handle disagreement constructively.

Must have:
- Strong SQL and data warehousing (Snowflake, Redshift or BigQuery).
- Proven experience building production data pipelines.
- Cloud platform experience (AWS/GCP/Azure), observability and reliability practices.

Preferred:
- Experience with data governance and security/compliance.
- Exposure to machine learning feature pipelines.`;

export const DEMO_RESUME = `Priya Sharma
Senior Data Engineer | Bengaluru
priya.sharma@example.com

Experience:
Senior Data Engineer, FinEdge Analytics (2021 - Present)
- Owned the analytical data platform on Snowflake serving 200+ internal analysts.
- Designed dimensional data models and slowly changing dimensions for finance reporting.
- Built and operated Airflow + dbt pipelines processing 4TB/day; reduced pipeline failures by 60% via idempotent recovery and better detection.
- Led migration from Redshift to Snowflake, cutting warehouse cost by 35%.
- Optimized critical SQL, improving key report latency from 90s to under 8s using partitioning and clustering.

Data Engineer, ShopStack (2018 - 2021)
- Built streaming pipelines with Spark and Kafka for clickstream analytics.
- Implemented observability and alerting; established on-call runbooks and SLAs.

Education:
B.Tech, Computer Science, NIT Trichy (2018)

Skills: SQL, Python, Snowflake, Redshift, Airflow, dbt, Spark, Kafka, AWS, Terraform, data modeling

Certifications:
- AWS Certified Solutions Architect - Associate`;

export interface DemoIds {
  tenantId: string; userId: string; roleId: string; scorecardId: string;
  candidateId: string; sessionId: string; token: string; email: string; password: string;
}

/**
 * Refuse to run against a production database. `wipe()` deletes every row and
 * `createDemoData()` provisions an admin account whose password is published in
 * this repository — either one against real candidate data is catastrophic.
 * Set ALLOW_DEMO_SEED=true only if you genuinely intend this on a live box.
 */
function assertNotProduction(op: string): void {
  if (config.nodeEnv === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      `Refusing to ${op} with NODE_ENV=production. This would ${op === 'wipe' ? 'delete all real candidate data' : 'create an admin account with a publicly known password'}. ` +
      'Set ALLOW_DEMO_SEED=true only if that is genuinely what you want.',
    );
  }
}

/** Delete all demo data (dev/test only). */
export async function wipe(): Promise<void> {
  assertNotProduction('wipe');
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.humanReview.deleteMany();
  await prisma.assessmentVersion.deleteMany();
  await prisma.turn.deleteMany();
  await prisma.interviewPlanVersion.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.artifact.deleteMany();
  await prisma.interviewSession.deleteMany();
  await prisma.evidenceEdge.deleteMany();
  await prisma.evidenceNode.deleteMany();
  await prisma.candidateProfileVersion.deleteMany();
  // Assignment rows hold foreign keys onto Candidate, Role and User, so they
  // must go before their targets or the deletes below fail on a constraint.
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await prisma.candidate.deleteMany();
  await prisma.roleScorecardVersion.deleteMany();
  await prisma.role.deleteMany();
  await prisma.modelExecution.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}

export async function createDemoData(): Promise<DemoIds> {
  const email = 'demo@questor.local';
  const password = 'questor123';

  const tenant = await prisma.tenant.create({
    data: {
      name: 'Acme Corp', region: 'in',
      policyJson: JSON.stringify({
        // "recorded only with your consent" described something that does not
        // happen: no audio is ever stored. What does happen is that the voice is
        // captured, sent to a transcription service, and thrown away once the
        // text exists — and the text is kept. The spoken disclosure now says
        // that, because it is the first and sometimes only version a candidate
        // takes in.
        disclosureText: "Hello, I'm Schranders, an AI interviewer for this first-round conversation. So you know how this works: while you speak, your voice is captured and sent to a speech-to-text service to be written down. No recording of your voice is stored — the written transcript is what is kept, and it is what our hiring team reviews. I'll ask about your relevant experience — take your time, and feel free to ask me to repeat anything or request a short pause.",
        recordingDefault: true, retentionDaysRecording: 90, retentionDaysTranscript: 180,
        allowedModules: ['coding', 'case'], languages: ['en'], humanReviewRequired: true,
      }),
    },
  });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email, name: 'Demo Recruiter', passwordHash: hashPassword(password), role: 'admin' },
  });

  // Role + scorecard (approved)
  const extraction = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer');
  const role = await prisma.role.create({
    data: { tenantId: tenant.id, title: extraction.title, level: extraction.level, location: extraction.location, employmentType: extraction.employmentType, sourceType: 'paste', sourceText: DEMO_JD, status: 'approved', createdById: user.id },
  });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(extraction.profile), approvedById: user.id, approvedAt: new Date() },
  });

  // Explicit ownership, even though the demo user happens to hold the admin role
  // and would therefore see this through the tenant-wide admin path anyway.
  // Relying on that would make the demo a demonstration of the break-glass
  // override rather than of how scoping actually works, and it would break the
  // moment someone sensibly downgrades the demo account to `recruiter`.
  await assignRole(role.id, user.id, 'owner');

  // Candidate + resume + fit
  const candidate = await prisma.candidate.create({
    data: { tenantId: tenant.id, roleId: role.id, fullName: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '' },
  });
  // Direct grant as well as the one inherited from the role: the demo is the
  // fixture the API tests and the E2E script drive, so it should exercise both
  // assignment paths rather than leaving the candidate one untested.
  await assignCandidate(candidate.id, user.id, 'owner');

  const profile = normalizeProfile(DEMO_RESUME);
  const { fit } = computeFitScore(profile, DEMO_RESUME, extraction.profile);
  await prisma.candidateProfileVersion.create({
    data: { candidateId: candidate.id, version: 1, rawText: DEMO_RESUME, profileJson: JSON.stringify(profile), fitScoreJson: JSON.stringify(fit) },
  });

  // Interview session + plan + invitation
  const plan = buildInterviewPlan({ role: extraction.profile, fit, durationMinutes: 45, language: 'en', modules: [] });
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id,
      state: 'ACCEPTED', provider: 'hosted', language: 'en', durationMinutes: 45,
      personaJson: JSON.stringify({ name: 'Schranders', tone: 'warm' }),
      consentJson: JSON.stringify({ disclosureText: JSON.parse(tenant.policyJson).disclosureText, recordingRequested: true, recording: true, humanReviewRequired: true, consentVersion: 'v1', consentedAt: new Date().toISOString(), channel: 'seed' }),
      recordingConsent: true,
    },
  });
  await prisma.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });
  const token = nanoid(24);
  await prisma.invitation.create({ data: { sessionId: session.id, token, status: 'accepted', sentAt: new Date(), acceptedAt: new Date(), expiresAt: new Date(Date.now() + 14 * 864e5) } });

  return { tenantId: tenant.id, userId: user.id, roleId: role.id, scorecardId: scorecard.id, candidateId: candidate.id, sessionId: session.id, token, email, password };
}
