import { groupQuestions, librarySummary, sourceLabel, type AskedQuestion } from './questionsAskedModel';

/**
 * What the interviewer actually asked, block by block, and where each
 * question came from. Only interviews the question library planned send it.
 */
export function QuestionsAskedCard({ questions }: { questions: readonly AskedQuestion[] }) {
  const groups = groupQuestions(questions);
  return (
    <section className="card" data-testid="questions-asked" aria-labelledby="questions-asked-heading">
      <h2 id="questions-asked-heading" className="card-title">Questions asked</h2>
      <p className="muted small">{librarySummary(questions)}</p>
      {groups.map((g) => (
        <div key={g.competencyId} style={{ marginTop: 12 }}>
          <h3 className="small" style={{ margin: '0 0 4px' }}>{g.competencyName}</h3>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {g.questions.map((q, i) => (
              <li key={i} style={{ margin: '4px 0' }}>
                {q.question} <span className="muted small">[ {sourceLabel(q)} ]</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
