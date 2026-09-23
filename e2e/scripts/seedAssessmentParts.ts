// Seed two assessments for a visual check of the three-part assessment page:
// one nobody has reviewed yet (Part 2 is the form, Part 3 is empty) and one a
// reviewer has been through (Part 2 is the record, Part 3 is the comparison).
// Usage:
//   DATABASE_URL=file:<abs>/data/questor.db npx tsx e2e/scripts/seedAssessmentParts.ts
//
// Development only: it writes candidates, sessions, turns, assessments and a
// review straight through Prisma, into the demo tenant it finds. It prints the
// two assessment ids for the screenshot script to open.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMPETENCIES = [
  {
    id: 'system-design', name: 'System design', level: 4, requiredLevel: 4,
    rationale: 'Partitioned the ledger by tenant and defended the choice against a read-heavy alternative.',
    quote: 'We shard on tenant because the read pattern never crosses a tenant boundary.',
    at: 552_000,
  },
  {
    id: 'reliability', name: 'Distributed systems & reliability', level: 2, requiredLevel: 3,
    rationale: 'Named backoff but did not explain the failure mode it prevents.',
    quote: 'Jittered exponential backoff on the client, then a circuit breaker on the payment route.',
    at: 1_120_000,
  },
  {
    id: 'api-design', name: 'API design', level: 4, requiredLevel: 3,
    rationale: 'Versioning and idempotency reasoned about from the caller\'s side.',
    quote: 'The retry has to be safe, so the key goes in the request rather than the URL.',
    at: 1_442_000,
  },
  {
    id: 'debugging', name: 'Debugging under pressure', level: 3, requiredLevel: 3,
    rationale: 'Worked from graphs to hypothesis, but skipped the rollback question.',
    quote: 'p99 went from 120ms to nine seconds in about four minutes.',
    at: 725_000,
  },
  {
    id: 'collaboration', name: 'Collaboration & communication', level: 3, requiredLevel: 3,
    rationale: 'Clear with the interviewer; little said about working across teams.',
    quote: 'I wrote the handover doc before the on-call rotation flipped.',
    at: 1_878_000,
  },
];

const TURNS = [
  { speaker: 'interviewer', text: 'Walk me through the retry storm you mentioned — what did the graphs actually show?', at: 724_000, competencyId: 'debugging' },
  { speaker: 'candidate', text: 'p99 went from 120ms to nine seconds in about four minutes. The payment client was retrying three times with no jitter, so every failure multiplied.', at: 725_000, competencyId: 'debugging' },
  { speaker: 'interviewer', text: 'How would you lay the ledger out?', at: 551_000, competencyId: 'system-design' },
  { speaker: 'candidate', text: 'We shard on tenant because the read pattern never crosses a tenant boundary.', at: 552_000, competencyId: 'system-design' },
  { speaker: 'interviewer', text: 'What did you change first?', at: 1_119_000, competencyId: 'reliability' },
  { speaker: 'candidate', text: 'Jittered exponential backoff on the client, then a circuit breaker on the payment route so a slow dependency stops being an outage.', at: 1_120_000, competencyId: 'reliability' },
  { speaker: 'interviewer', text: 'And the API for it?', at: 1_441_000, competencyId: 'api-design' },
  { speaker: 'candidate', text: 'The retry has to be safe, so the key goes in the request rather than the URL.', at: 1_442_000, competencyId: 'api-design' },
  { speaker: 'interviewer', text: 'How did the rest of the team find out what you had changed?', at: 1_877_000, competencyId: 'collaboration' },
  { speaker: 'candidate', text: 'I wrote the handover doc before the on-call rotation flipped, and walked the next on-call through the breaker thresholds.', at: 1_878_000, competencyId: 'collaboration' },
];

function resultJson(turnIds: Map<string, string>) {
  return JSON.stringify({
    recommendation: 'CONSIDER',
    confidence: 0.62,
    evidenceCoverage: 0.86,
    overallScore: 74,
    summary: 'A strong systems thinker whose reliability answer arrived late and in one piece, after the section it belonged to had moved on.',
    competencies: COMPETENCIES.map((c) => ({
      id: c.id,
      name: c.name,
      level: c.level,
      requiredLevel: c.requiredLevel,
      confidence: 0.6,
      notEnoughEvidence: false,
      rationale: c.rationale,
      evidence: [{ turnId: turnIds.get(c.id) ?? '', startMs: c.at, endMs: c.at + 40_000, quote: c.quote }],
    })),
    strengths: ['Reasons about failure modes from real incidents, not from a textbook.'],
    concerns: ['Said little about working across teams.'],
    contradictions: [],
    openQuestions: ['How does he decide when a breaker should stay open?'],
    limitations: ['One section was cut short by a connection drop.'],
  });
}

async function buildOne(opts: { tenantId: string; roleId: string; scorecardId: string; name: string; email: string }) {
  const candidate = await prisma.candidate.create({
    data: { tenantId: opts.tenantId, fullName: opts.name, email: opts.email },
  });
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: opts.tenantId, candidateId: candidate.id, roleId: opts.roleId, scorecardId: opts.scorecardId,
      state: 'REVIEW_READY', startedAt: new Date(Date.now() - 3_600_000), completedAt: new Date(Date.now() - 1_800_000),
      interviewerKey: 'avery',
    },
  });
  const turnIds = new Map<string, string>();
  for (const [index, turn] of TURNS.entries()) {
    const written = await prisma.turn.create({
      data: {
        sessionId: session.id, index, speaker: turn.speaker, text: turn.text,
        startMs: turn.at, endMs: turn.at + 40_000, competencyId: turn.competencyId,
      },
    });
    if (turn.speaker === 'candidate') turnIds.set(turn.competencyId, written.id);
  }
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: session.id, scorecardId: opts.scorecardId, recommendation: 'CONSIDER',
      confidence: 0.62, evidenceCoverage: 0.86, resultJson: resultJson(turnIds),
    },
  });
  return { assessmentId: assessment.id, candidateId: candidate.id };
}

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  const reviewer = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id }, select: { id: true } });
  const role = await prisma.role.findFirstOrThrow({
    where: { tenantId: tenant.id },
    select: { id: true, scorecards: { select: { id: true }, orderBy: { version: 'desc' }, take: 1 } },
  });
  const scorecardId = role.scorecards[0]?.id;
  if (!scorecardId) throw new Error('The demo role has no scorecard; seed the demo data first.');

  const open = await buildOne({
    tenantId: tenant.id, roleId: role.id, scorecardId, name: 'Arjun Mehta', email: `arjun.parts.${Date.now()}@example.com`,
  });
  const reviewed = await buildOne({
    tenantId: tenant.id, roleId: role.id, scorecardId, name: 'Arjun Mehta', email: `arjun.reviewed.${Date.now()}@example.com`,
  });

  // The reviewed one: a verdict recorded blind first, with two levels changed,
  // so Part 2 and Part 3 both have something real in them.
  const review = await prisma.humanReview.create({
    data: {
      assessmentId: reviewed.assessmentId, reviewerId: reviewer.id, status: 'COMPLETED', disposition: 'PROCEED',
      reason: 'He gave the whole retry-storm diagnosis at 18:40 — jitter, breaker, and why a slow dependency is not '
        + 'the same as a down one. That is a 4, not a 2. The collaboration answer is thinner than I would like but '
        + 'the on-call handover is real evidence. Worth the next round.',
      comments: '', completedAt: new Date(), activeForAssessmentId: reviewed.assessmentId,
      aiVisibleBefore: false,
      overridesJson: JSON.stringify([
        { competencyId: 'reliability', from: 2, to: 4, reason: 'He described the retry-storm fix in full at 18:40; the AI scored the section where he was interrupted.' },
        { competencyId: 'collaboration', from: 3, to: 4, reason: 'Answered the on-call handover follow-up without prompting.' },
      ]),
    },
  });

  console.log(JSON.stringify({ open: open.assessmentId, reviewed: reviewed.assessmentId, reviewId: review.id }));
}

main().finally(() => prisma.$disconnect());
