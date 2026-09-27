/**
 * The first-run steps, with no runtime behind them.
 *
 * A list, not a bare union, so the web copy can be checked against it rather
 * than agreeing with itself — and in `domain/` rather than beside the service,
 * because that check is a web unit test and it must not drag Prisma and a
 * database connection in to read four strings. The one live enum mismatch this
 * product has had was a needs-you kind the server added and the web mirror
 * never learned, in the only HR-Box union with no parity test.
 */
export const FIRST_RUN_STEPS = ['role', 'scorecard', 'candidate', 'interview'] as const;

export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];
