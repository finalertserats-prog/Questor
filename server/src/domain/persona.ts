import { parseJsonOptional } from '../db.js';

/**
 * The interviewer's name as the session recorded it, or null.
 *
 * There is deliberately no default name any more. Every new session is given
 * one of the catalogue interviewers (services/interviewers.ts); a record with
 * no name is an old one, and inventing a name for it would put words in the
 * mouth of an interviewer the candidate never met. Callers show "your AI
 * interviewer" instead.
 */
export function personaNameOf(personaJson: string, sessionId: string): string | null {
  const persona = parseJsonOptional<{ name?: unknown }>(personaJson, {}, { model: 'InterviewSession', id: sessionId, field: 'personaJson' });
  return typeof persona.name === 'string' && persona.name.trim() ? persona.name.trim() : null;
}
