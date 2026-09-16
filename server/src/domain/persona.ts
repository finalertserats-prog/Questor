/**
 * The interviewer's default name. HR can rename the persona per session
 * (routes/interviews.ts, `persona.name`); everything that shows or speaks the
 * name must read the session's value and fall back to this one, never to its
 * own copy of the string.
 */
export const DEFAULT_PERSONA_NAME = 'Schranders';
