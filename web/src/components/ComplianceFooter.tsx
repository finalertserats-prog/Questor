import { Link } from 'react-router-dom';
import { CatalogAttribution } from './CatalogAttribution';
import { FOOTER_FRAMEWORKS, TRUST_SECTION_ID } from './trustModel';

/**
 * The quiet line at the foot of the sign-in pages: what Questor is built for,
 * a way to read how, and the attributions the catalog's licences require.
 * Present from first paint, so it never moves the form.
 */
export function ComplianceFooter() {
  return (
    <footer className="compliance-footer">
      <p className="compliance-footer-line">
        Built for {FOOTER_FRAMEWORKS.join(' · ')} — <Link to={`/about#${TRUST_SECTION_ID}`}>how we handle your data</Link>
        {' · '}<Link to="/privacy">Privacy</Link>
      </p>
      <CatalogAttribution className="compliance-footer-attribution" />
    </footer>
  );
}
