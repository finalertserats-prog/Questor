import { Icon } from '../Icon';
import { evidenceChips, levelText, meterCells } from './verdictFlowModel';

/**
 * The skills, below the decision, each score beside the words that earned it.
 *
 * The evidence was a wall of quotes in a table cell: readable, and impossible
 * to check, because finding the quoted moment in the transcript meant reading
 * the transcript. Each quote is now a chip carrying the time it was said, and
 * pressing one marks that turn in the transcript alongside. The turn is the
 * one the evaluator recorded (EvidenceSpan.turnId) — not one matched back from
 * the text, which a truncated quote never matched.
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
}

export function SkillsGrid({ skills, activeChip, onChip }: SkillsGridProps) {
  if (skills.length === 0) return null;
  return (
    <section aria-labelledby="skills-heading">
      <div className="block-h">
        <h2 id="skills-heading">Skills</h2>
        <small className="muted">Levels out of 5 · a quote marks its turn in the transcript</small>
      </div>
      <ul className="skills" data-testid="skills-grid">
        {skills.map((skill) => (
          <li key={skill.id} className="skill">
            <p className="skill-h">
              <b>{skill.name}</b>
              <span className="skill-level">{levelText(skill.level, skill.notEnoughEvidence)}</span>
            </p>
            {/* The meter repeats what the text beside it already says, so it
                is decorative: a screen reader should not read it twice. */}
            <span className="skill-meter" aria-hidden="true">
              {meterCells(skill.level).map((cell, i) => <i key={i} className={`is-${cell}`} />)}
            </span>
            <p className="skill-need muted">Needs {skill.requiredLevel}/5</p>
            {skill.notEnoughEvidence && (
              <p className="skill-thin"><Icon name="alert" size={14} />The interview did not reach this.</p>
            )}
            {skill.rationale && <p className="skill-why muted">{skill.rationale}</p>}
            {evidenceChips(skill.evidence).length > 0 && (
              <div className="ev-chips">
                {evidenceChips(skill.evidence).map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    className="ev-chip"
                    aria-pressed={activeChip === chip.key}
                    data-testid="evidence-chip"
                    onClick={() => onChip(chip)}
                  >
                    <span className="ev-at">{chip.stamp}</span>
                    <span className="ev-quote">“{chip.quote}”</span>
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
