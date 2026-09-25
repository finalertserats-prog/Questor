import { Icon } from '../Icon';
import { evidenceChips, levelText, meterCells } from './verdictFlowModel';

/**
 * The competencies, with the evidence that earned each one.
 *
 * They sit inside "What the AI found", ABOVE the reviewer's form rather than
 * below it, because they are what the reviewer works from: the competency, the
 * level the role needs, and the moments in the interview that bear on it.
 * Pressing a quote marks that turn in the transcript alongside — the turn the
 * evaluator recorded (EvidenceSpan.turnId), not one matched back from text,
 * which a truncated quote never matched.
 *
 * MASKED, in an organisation that requires blind review, until the reviewer
 * has recorded their own verdict. Masked, not hidden: the competency name,
 * what the role asks for and the evidence quotes with their timestamps are
 * facts from the transcript and the approved scorecard, and withholding them
 * would leave the reviewer judging from nothing. What is withheld is the AI's
 * own opinion — the level, the meter and the one-line rationale — because that
 * is the thing blind review exists to keep out of their head.
 */

export interface SkillEvidence {
  readonly turnId: string;
  readonly startMs: number;
  readonly quote: string;
}

export interface SkillView {
  readonly id: string;
  readonly name: string;
  readonly level: number | null;
  readonly requiredLevel: number;
  readonly notEnoughEvidence: boolean;
  readonly rationale: string;
  readonly evidence: readonly SkillEvidence[];
}

export interface SkillsGridProps {
  readonly skills: readonly SkillView[];
  /** The evidence chip currently marking a turn, by chip key. */
  readonly activeChip: string;
  readonly onChip: (chip: { readonly key: string; readonly turnId: string }) => void;
  /** Withhold the AI's own reading of each competency, keeping the evidence. */
  readonly masked?: boolean;
}

const MASK_NOTE = 'The levels and the AI’s reasoning are withheld until you record your own verdict. '
  + 'What the role asks for, and what the candidate actually said, are not — you judge from those.';

export function SkillsGrid({ skills, activeChip, onChip, masked = false }: SkillsGridProps) {
  if (skills.length === 0) return null;
  const chipsFor = new Map(skills.map((skill) => [skill.id, evidenceChips(skill.evidence)]));
  return (
    <section aria-labelledby="skills-heading">
      <div className="block-h">
        <h3 id="skills-heading">Competencies</h3>
        <small className="muted">
          {masked
            ? 'What the role asks for, and the evidence · a quote marks its turn in the transcript'
            : 'Levels out of 5 · a quote marks its turn in the transcript'}
        </small>
      </div>
      {masked && (
        <p className="skills-masked-note" data-testid="skills-masked-note">
          <Icon name="eye-off" size={15} />{MASK_NOTE}
        </p>
      )}
      <ul className="skills" data-testid="skills-grid" data-masked={masked ? 'true' : 'false'}>
        {skills.map((skill) => (
          <li key={skill.id} className={masked ? 'skill is-masked' : 'skill'}>
            <p className="skill-h">
              <b>{skill.name}</b>
              {masked
                ? <span className="skill-withheld" data-testid="skill-withheld">Level withheld</span>
                : <span className="skill-level">{levelText(skill.level, skill.notEnoughEvidence)}</span>}
            </p>
            {/* The meter repeats what the text beside it already says, so it
                is decorative: a screen reader should not read it twice. It is
                the AI's reading, so it goes when the reading is masked. */}
            {!masked && (
              <span className="skill-meter" aria-hidden="true">
                {meterCells(skill.level).map((cell, i) => <i key={i} className={`is-${cell}`} />)}
              </span>
            )}
            {/* Absent rather than zero: a competency whose required level did
                not reach the page must not read as "needs nothing". */}
            {skill.requiredLevel > 0 && <p className="skill-need muted">Needs {skill.requiredLevel}/5</p>}
            {!masked && skill.notEnoughEvidence && (
              <p className="skill-thin"><Icon name="alert" size={14} />The interview did not reach this.</p>
            )}
            {!masked && skill.rationale && <p className="skill-why muted">{skill.rationale}</p>}
            {(chipsFor.get(skill.id) ?? []).length > 0 && (
              <div className="ev-chips">
                {(chipsFor.get(skill.id) ?? []).map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    className="ev-chip"
                    aria-pressed={activeChip === chip.key}
                    data-testid="evidence-chip"
                    onClick={() => onChip(chip)}
                  >
                    <span className="ev-at">{chip.stamp}</span>
                    <span className="ev-quote">&ldquo;{chip.quote}&rdquo;</span>
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
