import { Link } from 'react-router-dom';

/**
 * The link to the privacy page, wherever a candidate is.
 *
 * One component rather than a Link in five places, so the page can never be
 * reachable from the sign-in footer and not from the consent screen — which is
 * the surface that matters most, since that is where someone agrees to the
 * interview. Opens in a new tab from the candidate flow: a candidate halfway
 * through consent must not lose their place to read it.
 */
export function PrivacyLink({ label = 'How Questor handles your data', className }: {
  readonly label?: string;
  readonly className?: string;
}) {
  return <Link to="/privacy" target="_blank" rel="noreferrer" className={className}>{label}</Link>;
}
