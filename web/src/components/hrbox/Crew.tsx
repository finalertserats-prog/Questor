import { crewNote, type CrewMember } from './needsYouModel';

/**
 * The five AI interviewers as a small signature under the greeting. Whoever is
 * interviewing right now carries the room's voice ring; the rest say what is
 * next for them. Names only: the interviewers differ by name and voice alone.
 */
export function Crew({ crew, timeZone }: { crew: readonly CrewMember[]; timeZone: string }) {
  if (crew.length === 0) return null;
  return (
    <ul className="hb-crew" aria-label="Your interviewers">
      {crew.map((member) => {
        const note = crewNote(member, timeZone);
        const detail = member.status === 'live' && member.candidateFirstName ? `, interviewing ${member.candidateFirstName}` : '';
        return (
          <li key={member.id} className={`hb-crew-member${member.status === 'live' ? ' is-live' : ''}`}>
            <span className="hb-ring" aria-hidden="true"><span className="hb-avatar">{member.name.slice(0, 1)}</span></span>
            <span className="hb-crew-name">{member.name}</span>
            <small>
              <span className="visually-hidden">: </span>
              {note}
              <span className="visually-hidden">{detail}</span>
            </small>
          </li>
        );
      })}
    </ul>
  );
}
