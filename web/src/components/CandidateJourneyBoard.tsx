import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { StatusBadge } from './StatusBadge';
import { Badge, recBadge, Meter } from './ui';
import type {
  CandidateJourney, ColumnState, JourneyColumn, JourneyRoundCard,
} from './candidateJourney';

/**
 * The candidate journey board: four numbered steps across the top of the
 * candidate's page, each showing what Questor actually holds at that step.
 *
 * Everything here is presentation. What the columns mean, and every sentence
 * that could become untrue, lives in candidateJourney.ts where it is tested.
 * The actions — start pipeline, advance, schedule, complete, decide — stay in
 * the pipeline panel below the board, so this component cannot fall out of step
 * with what those actions actually do.
 *
 * The file is named CandidateJourneyBoard rather than CandidateJourney because
 * a case-insensitive filesystem cannot tell CandidateJourney.tsx from
 * candidateJourney.ts, and TypeScript refuses to load both.
 */

const STATE_TEXT: Readonly<Record<ColumnState, string>> = {
  done: 'Done',
  current: 'Current step',
  upcoming: 'Upcoming',
};

const STAGE_STATE_TEXT: Readonly<Record<string, string>> = {
  done: 'Completed',
  current: 'Current stage',
  upcoming: 'Upcoming',
  decided: 'Decision made here',
  skipped: 'Not needed',
};

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function Column({ column, children }: { column: JourneyColumn; children: ReactNode }) {
  return (
    <li
      className={`journey-col journey-col-${column.state}`}
      // The step a recruiter is on, announced as a step in a sequence rather
      // than merely coloured differently.
      aria-current={column.state === 'current' ? 'step' : undefined}
    >
      <div className="journey-col-head">
        <span className="journey-step" aria-hidden="true">{column.step}</span>
        <div className="journey-col-heading">
          <h3 className="journey-col-title"><Icon name={column.icon} size={16} />{column.title}</h3>
          <span className="journey-col-state">Step {column.step} of 4 · {STATE_TEXT[column.state]}</span>
        </div>
      </div>
      <div className="journey-col-body">{children}</div>
    </li>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="journey-block">
      <h4 className="journey-block-title">{title}</h4>
      {children}
    </section>
  );
}

function RoundCard({ round }: { round: JourneyRoundCard }) {
  return (
    <div className="journey-card">
      <div className="journey-card-title">
        <span>{round.stageLabel}</span>
        <StatusBadge kind="round" value={round.status} />
      </div>
      <span className="journey-card-meta">
        {round.interviewers.length > 0 ? round.interviewers.join(', ') : round.interviewerNote}
      </span>
      <span className="journey-card-meta journey-when">
        {round.completedAt ? `Completed ${when(round.completedAt)}` : when(round.scheduledAt)}
      </span>
    </div>
  );
}

export function CandidateJourneyBoard({ journey }: { journey: CandidateJourney }) {
  const { onboard, aiInterview, schedule, decision } = journey;

  return (
    <section className="journey" aria-labelledby="journey-title">
      <div className="journey-head">
        <h2 className="journey-title" id="journey-title">{journey.title}</h2>
        <span className="journey-subtitle">Four steps, in order. A person decides the outcome.</span>
      </div>

      <ol className="journey-board">
        {/* ---- 1. Onboard -------------------------------------------------- */}
        <Column column={onboard}>
          <div className="journey-person">
            <span className="journey-avatar" aria-hidden="true">{onboard.profile.initials}</span>
            <div style={{ minWidth: 0 }}>
              <div className="journey-person-name">{onboard.profile.fullName}</div>
              <div className="journey-person-meta">{onboard.profile.email}</div>
              <div className="journey-person-meta">
                {onboard.profile.roleTitle ?? 'No role recorded'}
              </div>
            </div>
          </div>

          <Block title="Job description">
            {onboard.job.available ? (
              <div className="journey-scroll" tabIndex={0} role="region" aria-label="Job description for this role">
                {onboard.job.context && <p className="journey-body-text">{onboard.job.context}</p>}
                {onboard.job.outcomes.length > 0 && (
                  <ul className="journey-list">{onboard.job.outcomes.map((o, i) => <li key={i}>{o}</li>)}</ul>
                )}
                {onboard.job.responsibilities.length > 0 && (
                  <ul className="journey-list">{onboard.job.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul>
                )}
                {onboard.job.source && <p className="journey-note">{onboard.job.source}</p>}
              </div>
            ) : (
              <p className="journey-note">{onboard.job.note}</p>
            )}
          </Block>

          <Block title="Parsed resume">
            {onboard.resume.parsed ? (
              <>
                {onboard.resume.totalYears != null && (
                  <p className="journey-note">{onboard.resume.totalYears} years of experience</p>
                )}
                {onboard.resume.skills.length > 0 && (
                  <div>{onboard.resume.skills.slice(0, 12).map((s, i) => <span key={i} className="chip">{s}</span>)}</div>
                )}
                {onboard.resume.excerpt && (
                  <div className="journey-scroll" tabIndex={0} role="region" aria-label="Parsed resume text">
                    <p className="journey-written">{onboard.resume.excerpt}</p>
                  </div>
                )}
              </>
            ) : (
              <p className="journey-note">{onboard.resume.note}</p>
            )}
          </Block>

          <Block title="Job fit">
            {onboard.fit.scored ? (
              <>
                <div className="journey-measure">
                  <span className="muted">Overall fit</span>
                  <b>{onboard.fit.overall}/100</b>
                </div>
                <Meter value={onboard.fit.overall ?? 0} />
                <div className="journey-measure" style={{ marginTop: 6 }}>
                  <span className="muted">Confidence</span>
                  <b>{Math.round((onboard.fit.confidence ?? 0) * 100)}%</b>
                </div>
                {onboard.fit.missing.length > 0 && (
                  <p className="journey-note">Missing: {onboard.fit.missing.join(', ')}</p>
                )}
                <p className="journey-note">{onboard.fit.note}</p>
              </>
            ) : (
              <p className="journey-note">{onboard.fit.note}</p>
            )}
          </Block>
        </Column>

        {/* ---- 2. AI interview --------------------------------------------- */}
        <Column column={aiInterview}>
          <Block title={aiInterview.stageLabel ? `${aiInterview.stageLabel} · conducted by Schranders` : 'Conducted by Schranders'}>
            {aiInterview.session ? (
              <>
                <div className="journey-links" style={{ marginBottom: 6 }}>
                  <StatusBadge kind="interview" value={aiInterview.session.state} />
                  {aiInterview.awaitingHumanReview && (
                    <Badge kind="amber">Awaiting human review</Badge>
                  )}
                </div>
                <p className="journey-note">{aiInterview.statusNote}</p>
              </>
            ) : (
              <p className="journey-note">{aiInterview.statusNote}</p>
            )}
          </Block>

          <Block title="When">
            <p className="journey-note journey-when">
              {aiInterview.completedAt
                ? `Completed ${when(aiInterview.completedAt)}`
                : aiInterview.scheduledAt
                  ? `Scheduled for ${when(aiInterview.scheduledAt)}`
                  : 'Not scheduled yet.'}
            </p>
          </Block>

          <Block title="Watch or read">
            <div className="journey-links">
              {aiInterview.observeHref && (
                <Link to={aiInterview.observeHref}><Icon name="eye" size={15} />Observe live</Link>
              )}
              {aiInterview.transcriptHref && (
                <Link to={aiInterview.transcriptHref}><Icon name="captions" size={15} />Transcript</Link>
              )}
              {aiInterview.assessmentHref && (
                <Link to={aiInterview.assessmentHref}><Icon name="evidence" size={15} />Assessment</Link>
              )}
              {!aiInterview.observeHref && !aiInterview.transcriptHref && aiInterview.interviewHref && (
                <Link to={aiInterview.interviewHref}><Icon name="interviews" size={15} />Interview</Link>
              )}
            </div>
            <p className="journey-note">{aiInterview.observeNote}</p>
            <p className="journey-note">{aiInterview.conductedByNote}</p>
          </Block>
        </Column>

        {/* ---- 3. Schedule ------------------------------------------------- */}
        <Column column={schedule}>
          <Block title="Human rounds">
            {schedule.stages.length === 0 ? (
              <p className="journey-note">{schedule.note}</p>
            ) : (
              <>
                {schedule.stages.map((stage) => (
                  <div
                    key={stage.key}
                    className={stage.state === 'current' ? 'journey-stage-group journey-stage-current' : 'journey-stage-group'}
                  >
                    <h5 className="journey-stage-name">
                      {stage.label}
                      <span className="journey-stage-state">{STAGE_STATE_TEXT[stage.state] ?? stage.state}</span>
                    </h5>
                    {stage.rounds.length === 0
                      ? <p className="journey-note">{stage.note}</p>
                      : stage.rounds.map((round) => <RoundCard key={round.id} round={round} />)}
                  </div>
                ))}
                <p className="journey-note" style={{ marginTop: 10 }}>{schedule.note}</p>
              </>
            )}
          </Block>

          {schedule.orphanRounds.length > 0 && (
            <Block title="Rounds from an earlier stage plan">
              {schedule.orphanRounds.map((round) => <RoundCard key={round.id} round={round} />)}
            </Block>
          )}
        </Column>

        {/* ---- 4. Decision & evidence -------------------------------------- */}
        <Column column={decision}>
          <Block title="Assessment">
            <div className="journey-links" style={{ marginBottom: 6 }}>
              {recBadge(decision.recommendation)}
            </div>
            {decision.assessment.available ? (
              <>
                {decision.assessment.summary && <p className="journey-body-text">{decision.assessment.summary}</p>}
                {decision.assessment.href && (
                  <div className="journey-links">
                    <Link to={decision.assessment.href}><Icon name="evidence" size={15} />Full assessment</Link>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="journey-note">{decision.assessment.note}</p>
                {decision.assessment.blocked && decision.assessment.href && (
                  <div className="journey-links">
                    <Link to={`${decision.assessment.href}/review`}><Icon name="scale" size={15} />Record your verdict</Link>
                  </div>
                )}
              </>
            )}
          </Block>

          {decision.assessment.quotes.length > 0 && (
            <Block title="Evidence">
              <div className="journey-scroll" tabIndex={0} role="region" aria-label="Evidence quoted from the interview transcript">
                {decision.assessment.quotes.map((quote, i) => (
                  <blockquote className="journey-quote" key={i}>
                    <p>“{quote.quote}”</p>
                    <span className="journey-quote-meta">
                      <span>{quote.competency}</span>
                      <span className="journey-when">{quote.timing}</span>
                    </span>
                  </blockquote>
                ))}
              </div>
              <p className="journey-note">{decision.assessment.evidenceNote}</p>
            </Block>
          )}

          {decision.assessment.notEnoughEvidence.length > 0 && (
            <Block title="Not enough evidence">
              <div>{decision.assessment.notEnoughEvidence.map((name, i) => <span key={i} className="chip muted">{name}</span>)}</div>
            </Block>
          )}

          <Block title="Interview notes">
            {decision.humanNotes.length === 0 ? (
              <p className="journey-note">No human round has been completed yet.</p>
            ) : (
              <>
                <div className="journey-scroll" tabIndex={0} role="region" aria-label="Notes written after the human interview rounds">
                  {decision.humanNotes.map((note) => (
                    <div className="journey-card" key={note.roundId}>
                      <div className="journey-card-title">
                        <span>{note.stageLabel}</span>
                        <span className="journey-when">{when(note.completedAt)}</span>
                      </div>
                      {note.interviewers.length > 0 && (
                        <span className="journey-card-meta">{note.interviewers.join(', ')}</span>
                      )}
                      <p className={note.retained ? 'journey-written' : 'journey-note'}>{note.notes}</p>
                    </div>
                  ))}
                </div>
                <p className="journey-note">{decision.humanNotesNote}</p>
              </>
            )}
          </Block>

          {decision.evidenceGaps.length > 0 && (
            <Block title="No evidence held for">
              <div>{decision.evidenceGaps.map((gap, i) => <span key={i} className="chip muted">{gap}</span>)}</div>
            </Block>
          )}

          <Block title="Decision">
            {decision.decision.recorded ? (
              <>
                <div className="journey-links" style={{ marginBottom: 6 }}>
                  <StatusBadge kind="decision" value={decision.decision.value ?? 'APPROVED'} />
                  {decision.decision.stageLabel && (
                    <span className="muted small">at {decision.decision.stageLabel}</span>
                  )}
                </div>
                <p className="journey-body-text">{decision.decision.reason}</p>
                <p className="journey-note journey-when">{when(decision.decision.decidedAt)}</p>
              </>
            ) : (
              <p className="journey-note">
                No decision recorded yet. Approve, do not progress, or record that the candidate withdrew,
                with a reason, in the pipeline below.
              </p>
            )}
          </Block>
        </Column>
      </ol>
    </section>
  );
}
