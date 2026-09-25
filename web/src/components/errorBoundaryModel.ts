/**
 * What the recovery screen says, kept free of React so it can be unit tested
 * (see web/tests/errorBoundary.test.ts). Plain words, no error text: whoever
 * reads this needs a way forward, not a diagnosis.
 */

export type BoundaryScope = 'app' | 'page';

export interface BoundaryCopy {
  readonly title: string;
  readonly body: string;
  readonly homeLabel: string;
}

export function boundaryCopy(scope: BoundaryScope): BoundaryCopy {
  if (scope === 'app') {
    return {
      title: 'Questor ran into a problem',
      body: 'Something went wrong while showing this screen. Try again, or start over from the home page.',
      homeLabel: 'Go to the home page',
    };
  }
  return {
    title: 'This page ran into a problem',
    body: 'Something went wrong while showing this page. The rest of Questor still works. Try again, or head back to the dashboard.',
    homeLabel: 'Go to the dashboard',
  };
}

/**
 * Candidate-facing addresses: no dashboard to send anyone to. /about and
 * /privacy are here because a candidate reads both without an account, and
 * offering them "go to the dashboard" sends them to a sign-in page.
 *
 * `/v/` is the widest case of all: the verification page on the face of every
 * certificate is usually read by an EMPLOYER, who has no account and never
 * will. Offering them a dashboard would be the one thing on the page that
 * suggests Questor wants something from them.
 */
const PUBLIC_PREFIXES = ['/portal/', '/room/', '/talk-to-a-person/', '/observer-consent/', '/feedback-consent/', '/v/', '/signup', '/demo', '/login', '/o/', '/forgot-password', '/reset-password', '/about', '/privacy'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
