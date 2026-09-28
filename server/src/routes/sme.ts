import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJsonOptional } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { logAudit } from '../services/audit.js';
import { assertSmeAssignment, smeAssignedCandidateIds } from '../services/smeAccess.js';
import { tenantTimeZone } from '../services/tenantTimeZone.js';
import { ownSmeReview, requireCandidateRole, saveSmeReview } from '../services/smeReview.js';
import {
  SME_ADVISORY_NOTE, SME_FEEDBACK_MAX, SME_FEEDBACK_MIN, SME_RECOMMENDATIONS,
} from '../domain/smeRecommendation.js';
import { LIVE_INTERVIEW_STATES, mayObserveLive } from '../services/observerPolicy.js';
import { leftByButton, LEAVE_SOURCE } from '../realtime/interviewEngine.js';
import { personaNameOf } from '../domain/persona.js';
import { blockOfRound } from '../domain/observedRound.js';
import type { AssessmentResult, RoleSuccessProfile } from '../domain/types.js';

/**
 * /api/sme — everything a subject-matter expert may reach, and nothing else.
 *
 * A separate surface rather than a widening of the existing routes, and that is
 * the central access-control decision of this role. `sme` holds none of
 * `candidate:read`, `role:read`, `interview:read` or `assessment:read`, so
 * every route in the rest of the product refuses an expert without anyone
 * having to have thought about them — including a route somebody adds next
 * month. The alternative, granting `candidate:read` and relying on object scope
 * to narrow it, would have meant that the candidate list, the pipeline, the
 * comparison grid and the dashboard all opened to them the moment they were
 * assigned anybody, which is precisely the table in
 * docs/credentials-contract.md §3 read backwards.
 *
 * What an expert DOES see is the candidate's name. Deliberate, and the one
 * place this role is wider than a blind reviewer: it is the owner's decision,
 * on the grounds that human assessment of a person is the thing being asked
 * for, and that the point of asking is learning where a person and the machine
 * read the same candidate differently.
 *
 * Every route scopes on `assertSmeAssignment`, which — unlike `candidateScope`
 * — has no admin bypass and does not admit a role assignment. An expert reaches
 * the people they were handed, by name, or nothing.
 */
export const smeRouter = Router();
smeRouter.use(authenticate);

const MAY_READ = requireCapability('sme:assigned_read');

/**
 * The rounds an expert is seated on, for the candidates in front of them.
 *
 * /api/sme returned no scheduled time anywhere: not on the worklist, not on
 * the candidate. An expert booked to conduct a Gold round could open Questor
 * and still have no way to find out when it was — so an email that went astray
 * left no second copy, and a lost email became an unrecoverable state.
 *
 * Scoped on the SEAT, the same way the rest of this file is scoped on the
 * assignment: an expert sees the rounds they are in the room for and no others,
 * even on a candidate they were handed.
 *
 * `scheduledTimeZone` travels as stored, null and all. A round booked through
 * the older offset-only API has no zone of its own (routes/scheduleTime.ts),
 * every reader then falls back to the organisation's — and for an expert in
 * another country that fallback is wrong without saying so. Null is the signal
 * the page needs to say which of the two it is showing; `orgTimeZone` rides
 * along so the page can resolve it without calling a route this role is not
 * allowed to call.
 *
 * No stage, no pipeline position: this file withholds both deliberately, and a
 * time does not need them.
 */
async function seatedRounds(tenantId: string, userId: string, candidateIds: readonly string[]) {
  if (candidateIds.length === 0) return [];
  return prisma.interviewRound.findMany({
    where: {
      tenantId, status: 'SCHEDULED',
      panel: { some: { userId } },
      pipeline: { candidateId: { in: [...candidateIds] } },
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, scheduledAt: true, scheduledTimeZone: true, durationMinutes: true, meetingUrl: true,
      pipeline: { select: { candidateId: true } },
    },
  });
}

type SeatedRound = Awaited<ReturnType<typeof seatedRounds>>[number];

const presentSeatedRound = (round: SeatedRound) => ({
  id: round.id,
  scheduledAt: round.scheduledAt,
  scheduledTimeZone: round.scheduledTimeZone,
  durationMinutes: round.durationMinutes,
  meetingUrl: round.meetingUrl,
});

/** The assessment stored on a session, or nothing rather than a half-read one. */
function storedResult(assessment: { id: string; resultJson: string }): AssessmentResult | null {
  const parsed = parseJsonOptional<Record<string, unknown> | null>(
    assessment.resultJson, null, { model: 'AssessmentVersion', id: assessment.id, field: 'resultJson' },
  );
  if (!parsed || typeof parsed !== 'object') return null;
  const score = (parsed as { overallScore?: unknown }).overallScore;
  // Same probe as routes/assessments.ts: `overallScore` is the field every
  // result shape has carried, and null is a legitimate value for it. A row that
  // fails it is damaged, and a damaged reading must not be put in front of
  // somebody being asked to judge a person against it.
  if (!(score === null || (typeof score === 'number' && Number.isFinite(score)))) return null;
  return parsed as unknown as AssessmentResult;
}

/**
 * The role's approved scorecard, read-only.
 *
 * The approved version, never a draft: an expert assessing against a scorecard
 * nobody has signed off is assessing against a work in progress, and their
 * recommendation would be about a different standard from the AI's.
 *
 * Only the parts that describe what "good" looks like travel. The scoring rules
 * and the pass threshold do not: they are how the machine turns evidence into a
 * number, and an expert who has read the threshold before writing is no longer
 * an independent reading of the same candidate.
 */
async function approvedScorecard(roleId: string) {
  const version = await prisma.roleScorecardVersion.findFirst({
    where: { roleId, status: 'approved' },
    orderBy: { version: 'desc' },
  });
  if (!version) return null;
  const profile = parseJsonOptional<Partial<RoleSuccessProfile>>(
    version.profileJson, {}, { model: 'RoleScorecardVersion', id: version.id, field: 'profileJson' },
  );
  return {
    version: version.version,
    approvedAt: version.approvedAt,
    roleContext: profile.roleContext ?? '',
    outcomes: profile.outcomes ?? [],
    responsibilities: profile.responsibilities ?? [],
    competencies: (profile.competencies ?? []).map((competency) => ({
      id: competency.id,
      name: competency.name,
      definition: competency.definition,
      category: competency.category,
      classification: competency.classification,
      requiredLevel: competency.requiredLevel,
      targetLevel: competency.targetLevel,
      indicators: competency.indicators,
    })),
  };
}

/**
 * GET /api/sme/assignments — the expert's own worklist.
 *
 * Their assigned candidates and nothing about anyone else's. Not a filtered
 * candidate list: there is no unfiltered one for this role to fall back to.
 */
/**
 * The rounds this expert is seated on that cannot go ahead, keyed by candidate.
 *
 * Every human round is recorded, so a round somebody has not agreed to be
 * recorded in does not run (domain/observedRound.ts). The expert has to be told
 * where they look, which is here: leaving them to find out by opening an empty
 * room at the scheduled time wastes their preparation and is the kind of dead
 * end this product keeps having to go back and fix.
 *
 * Scoped by the seat, never by the candidate id alone. `RoundInterviewer` is
 * the only thing that puts an expert in a room, so a round they are not on is
 * not theirs to be told about, assigned candidate or not.
 */
async function blockedSeatedRounds(userId: string, tenantId: string, candidateIds: readonly string[]) {
  const rounds = await prisma.interviewRound.findMany({
    where: {
      tenantId, status: 'SCHEDULED', conductedBy: 'HUMAN',
      panel: { some: { userId } },
      pipeline: { status: 'ACTIVE', candidateId: { in: [...candidateIds] } },
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, stageKey: true, scheduledAt: true, status: true,
      panel: { select: { userId: true } },
      pipeline: { select: { candidateId: true } },
      observation: {
        select: {
          status: true, withdrawnReason: true, stoppedBy: true, declinedBy: true,
          _count: { select: { segments: { where: { kind: 'SPEECH' } } } },
          participants: { select: { party: true, personId: true, consentAt: true, declinedAt: true, admittedAt: true } },
        },
      },
    },
  });
  const byCandidate = new Map<string, Array<{ roundId: string; stageKey: string; scheduledAt: Date; reason: string; nextSteps: readonly string[] }>>();
  for (const round of rounds) {
    const block = blockOfRound({
      roundStatus: round.status,
      seats: round.panel.map((seat) => seat.userId),
      observation: round.observation
        ? { ...round.observation, speechCount: round.observation._count.segments }
        : null,
    });
    if (!block) continue;
    const list = byCandidate.get(round.pipeline.candidateId) ?? [];
    list.push({ roundId: round.id, stageKey: round.stageKey, scheduledAt: round.scheduledAt, reason: block.reason, nextSteps: block.nextSteps });
    byCandidate.set(round.pipeline.candidateId, list);
  }
  return byCandidate;
}

smeRouter.get('/assignments', MAY_READ, asyncHandler(async (req, res) => {
  const candidateIds = await smeAssignedCandidateIds(req.auth!.userId);
  if (candidateIds.length === 0) return res.json({ assignments: [], note: SME_ADVISORY_NOTE });

  const candidates = await prisma.candidate.findMany({
    where: { id: { in: candidateIds }, tenantId: req.auth!.tenantId },
    select: { id: true, fullName: true, roleId: true, role: { select: { id: true, title: true, level: true } } },
  });
  const [reviews, rounds, orgTimeZone, blockedRounds] = await Promise.all([
    prisma.smeReview.findMany({
      where: { smeUserId: req.auth!.userId, candidateId: { in: candidates.map((c) => c.id) } },
      select: { candidateId: true, roleId: true, recommendation: true, updatedAt: true },
    }),
    seatedRounds(req.auth!.tenantId, req.auth!.userId, candidates.map((c) => c.id)),
    tenantTimeZone(req.auth!.tenantId),
    blockedSeatedRounds(req.auth!.userId, req.auth!.tenantId, candidateIds),
  ]);
  // The one still ahead, else the last one there was. An expert brought in
  // after the round to read the recording needs the date as much as one who is
  // about to conduct it — "when was this?" and "when is this?" are the same
  // column, and an empty cell answers neither.
  const now = Date.now();
  const roundFor = (candidateId: string) => {
    const mine = rounds.filter((r) => r.pipeline.candidateId === candidateId);
    return mine.find((r) => r.scheduledAt.getTime() >= now) ?? mine[mine.length - 1];
  };
  // Keyed by candidate AND role, because that is what a review is unique on. A
  // candidate whose role changed after they were read once would otherwise show
  // as done on a role nobody has read them for — and the expert would take the
  // tick at its word and skip them, which is the one way this list can cost
  // somebody an assessment rather than merely look wrong.
  const reviewed = new Map(reviews.map((review) => [`${review.candidateId}:${review.roleId}`, review]));
  const reviewOf = (candidate: { id: string; roleId: string | null }) => (
    candidate.roleId ? reviewed.get(`${candidate.id}:${candidate.roleId}`) : undefined
  );

  // The assignment order, so the list reads newest-first like every other
  // worklist rather than in whatever order the candidate rows came back.
  const position = new Map(candidateIds.map((id, index) => [id, index]));

  res.json({
    assignments: [...candidates]
      .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
      .map((candidate) => ({
        candidateId: candidate.id,
        // The expert sees who this is. See the file comment.
        name: candidate.fullName,
        role: candidate.role ? { id: candidate.role.id, title: candidate.role.title, level: candidate.role.level } : null,
        round: roundFor(candidate.id) ? presentSeatedRound(roundFor(candidate.id)!) : null,
        review: reviewOf(candidate)
          ? { recommendation: reviewOf(candidate)!.recommendation, updatedAt: reviewOf(candidate)!.updatedAt }
          : null,
        // Rounds of theirs that cannot go ahead, each with the reason in a
        // sentence and what can be done next. Empty for the ordinary case.
        blockedRounds: blockedRounds.get(candidate.id) ?? [],
      })),
    orgTimeZone,
    note: SME_ADVISORY_NOTE,
  });
}));

/**
 * GET /api/sme/candidates/:id — one candidate, as an expert sees them.
 *
 * Identity, the role's approved scorecard, the interviews there are to read,
 * and their own recommendation if they have written one. No pipeline, no stage,
 * no other expert's review, and no decision the hiring team has taken: an
 * expert told the team is leaning one way is no longer an independent reading,
 * which is the only thing they were asked for.
 */
smeRouter.get('/candidates/:id', MAY_READ, asyncHandler(async (req, res) => {
  const candidate = await assertSmeAssignment(req.auth!, req.params.id);
  // Read rather than required here, unlike the write below. A candidate with no
  // role yet is a thin page rather than a refusal: an expert who followed their
  // own worklist to a dead end would reasonably read it as having lost access,
  // and "there is nothing settled to assess against yet" is the true answer.
  const roleId = candidate.roleId;

  const [role, scorecard, sessions, own, rounds, orgTimeZone] = await Promise.all([
    roleId ? prisma.role.findFirst({ where: { id: roleId, tenantId: req.auth!.tenantId }, select: { id: true, title: true, level: true } }) : null,
    roleId ? approvedScorecard(roleId) : null,
    roleId ? prisma.interviewSession.findMany({
      where: { candidateId: candidate.id, roleId, tenantId: req.auth!.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, state: true, startedAt: true, completedAt: true, durationMinutes: true, personaJson: true },
    }) : [],
    roleId ? ownSmeReview(candidate.id, roleId, req.auth!.userId) : null,
    seatedRounds(req.auth!.tenantId, req.auth!.userId, [candidate.id]),
    tenantTimeZone(req.auth!.tenantId),
  ]);

  res.json({
    candidate: { id: candidate.id, name: candidate.fullName, email: candidate.email, phone: candidate.phone, linkedinUrl: candidate.linkedinUrl },
    role,
    scorecard,
    interviews: sessions.map((session) => ({
      id: session.id,
      state: session.state,
      interviewer: personaNameOf(session.personaJson, session.id),
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      durationMinutes: session.durationMinutes,
    })),
    // Every round this expert is in the room for, soonest first.
    rounds: rounds.map(presentSeatedRound),
    orgTimeZone,
    review: own && {
      recommendation: own.recommendation, feedback: own.feedback, sessionId: own.sessionId, updatedAt: own.updatedAt,
    },
    note: SME_ADVISORY_NOTE,
  });
}));

/**
 * The session named must belong to the assigned candidate, for the role the
 * expert was asked about.
 *
 * Checked against the candidate rather than against the tenant: a session id
 * from elsewhere in the same organisation would pass a tenant check and hand an
 * expert a transcript of somebody they were never given — the object-scope hole
 * that services/access.ts exists to close, reached through a path parameter.
 *
 * And against the role as well as the candidate. An expert is asked to assess
 * one person for one role, and the scorecard they are shown is that role's. A
 * session recorded against a different role is a conversation held to a
 * different standard, about a job they were not asked about, and the page never
 * lists it — so reaching it means typing the id, which is precisely the case an
 * object-scope check exists for. A candidate with no role has no such
 * conversation to reach either.
 */
async function assignedSession(auth: { tenantId: string }, candidate: { id: string; roleId: string | null }, sessionId: string) {
  if (!candidate.roleId) throw new HttpError(404, 'Interview not found');
  const session = await prisma.interviewSession.findFirst({
    where: { id: sessionId, candidateId: candidate.id, roleId: candidate.roleId, tenantId: auth.tenantId },
  });
  if (!session) throw new HttpError(404, 'Interview not found');
  return session;
}

/** GET /api/sme/candidates/:id/interviews/:sessionId/transcript — what was said. */
smeRouter.get('/candidates/:id/interviews/:sessionId/transcript', MAY_READ, asyncHandler(async (req, res) => {
  const candidate = await assertSmeAssignment(req.auth!, req.params.id);
  const session = await assignedSession(req.auth!, candidate, req.params.sessionId);

  // While the candidate may still be on the call, reading the transcript is
  // live observation, and gets the same consent gate the hiring team's own
  // route does — the candidate agreed to being observed or they did not, and
  // which staff role is reading does not change that.
  if (LIVE_INTERVIEW_STATES.has(session.state) && !(await mayObserveLive(session))) {
    throw new HttpError(409, 'The transcript is available once the interview ends.');
  }

  const turns = await prisma.turn.findMany({ where: { sessionId: session.id }, orderBy: { index: 'asc' } });
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user',
    action: 'sme.transcript_read', entityType: 'InterviewSession', entityId: session.id, requestId: req.requestId,
  });

  res.json({
    transcript: turns.map((turn) => ({
      id: turn.id, index: turn.index, speaker: turn.speaker, text: turn.text,
      startMs: turn.startMs, endMs: turn.endMs, competencyId: turn.competencyId,
      ...(leftByButton(turn) ? { source: LEAVE_SOURCE } : {}),
    })),
    session: {
      interviewer: personaNameOf(session.personaJson, session.id),
      startedAt: session.startedAt, completedAt: session.completedAt, durationMinutes: session.durationMinutes,
    },
  });
}));

/**
 * GET /api/sme/candidates/:id/interviews/:sessionId/assessment — what the AI made of it.
 *
 * The competency readings and the AI's own summary. Not the human review, the
 * overrides, the differences or the pipeline consequence: those are the hiring
 * team's working-out, and an expert reading them is reading the answer before
 * writing their own.
 */
smeRouter.get('/candidates/:id/interviews/:sessionId/assessment', MAY_READ, asyncHandler(async (req, res) => {
  const candidate = await assertSmeAssignment(req.auth!, req.params.id);
  const session = await assignedSession(req.auth!, candidate, req.params.sessionId);

  const assessment = await prisma.assessmentVersion.findFirst({
    where: { sessionId: session.id },
    orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, resultJson: true, createdAt: true },
  });
  if (!assessment) return res.json({ assessment: null });

  const result = storedResult(assessment);
  if (!result) throw new HttpError(500, 'This assessment could not be read.');

  res.json({
    assessment: {
      id: assessment.id,
      scoredAt: assessment.createdAt,
      overallScore: result.overallScore,
      recommendation: result.recommendation,
      summary: result.summary,
      competencies: result.competencies,
      strengths: result.strengths,
      concerns: result.concerns,
      openQuestions: result.openQuestions,
      limitations: result.limitations,
    },
    note: SME_ADVISORY_NOTE,
  });
}));

const reviewSchema = z.object({
  recommendation: z.enum(SME_RECOMMENDATIONS),
  feedback: z.string().trim().min(SME_FEEDBACK_MIN, 'Say why, in a sentence or two. The reasoning is the part the hiring team cannot get anywhere else.').max(SME_FEEDBACK_MAX),
  // Which interview this is about, when it is about one. Optional: an expert
  // may be asked to read a CV against the scorecard before any interview has
  // happened.
  sessionId: z.string().min(1).nullish(),
});

/**
 * PUT /api/sme/candidates/:id/review — record or revise this expert's recommendation.
 *
 * PUT rather than POST: there is one recommendation per expert per candidate
 * and it is edited in place, so the second call must replace the first rather
 * than add to it (see the unique constraint on SmeReview).
 *
 * Note what this handler does NOT do. It writes no HumanReview, so it cannot
 * satisfy the Art. 22 review gate that services/humanReviewGate.ts enforces
 * before a pipeline decision. It calls neither `notePipelineEvent` nor
 * `decidePipeline`, so it moves nobody. And the role it is gated on holds
 * neither `interview:create` nor `assessment:review`, so the routes that DO
 * move people refuse the same caller. Three independent reasons, because this
 * is the one property of the role that must not quietly stop being true.
 */
smeRouter.put('/candidates/:id/review', requireCapability('sme:review'), asyncHandler(async (req, res) => {
  const body = reviewSchema.parse(req.body);
  const candidate = await assertSmeAssignment(req.auth!, req.params.id);
  const roleId = requireCandidateRole(candidate.roleId);

  // A session from another candidate would attach this recommendation to an
  // interview it is not about.
  if (body.sessionId) await assignedSession(req.auth!, candidate, body.sessionId);

  const { review, created } = await saveSmeReview({
    tenantId: req.auth!.tenantId,
    candidateId: candidate.id,
    roleId,
    sessionId: body.sessionId ?? null,
    smeUserId: req.auth!.userId,
    recommendation: body.recommendation,
    feedback: body.feedback,
    requestId: req.requestId,
  });

  res.status(created ? 201 : 200).json({
    review: {
      recommendation: review.recommendation, feedback: review.feedback,
      sessionId: review.sessionId, updatedAt: review.updatedAt,
    },
    note: SME_ADVISORY_NOTE,
  });
}));
