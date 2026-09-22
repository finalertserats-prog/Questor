import { CatalogAttribution } from './CatalogAttribution';
import {
  DPIA_SUMMARY, TRUST_FRAMEWORKS, TRUST_SECTION_ID, TRUST_SECURITY, trustStatusLabel, type TrustItem, type TrustStatus,
} from './trustModel';

function StatusMark({ status }: { readonly status: TrustStatus }) {
  return <span className={`trust-status trust-status-${status}`}>{trustStatusLabel(status)}</span>;
}

function TrustEntry({ item }: { readonly item: TrustItem }) {
  return (
    <li className="trust-item">
      <div className="trust-item-head">
        <span className="trust-item-topic">{item.topic}</span>
        <StatusMark status={item.status} />
      </div>
      <p className="trust-item-line"><span className="trust-item-label">The law asks</span>{item.asks}</p>
      <p className="trust-item-line"><span className="trust-item-label">What Questor does</span>{item.questor}</p>
    </li>
  );
}

/** Where a candidate's own data requests go: the organisation that invited them. */
function PrivacyRequests() {
  // The same build-time address the Contact page publishes; absent, the
  // organisation is the only honest answer, and it is the right one anyway.
  const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL as string | undefined;
  return (
    <p>
      To see, correct or delete your interview data, ask the organisation that invited you: it decides
      what happens to your data, and its administrators can erase it in Questor.
      {supportEmail && <> For questions about Questor itself, write to <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</>}
    </p>
  );
}

/**
 * How Questor meets the laws its research covers, with an honest status on
 * every line. The copy lives in trustModel.ts so the sign-in footer names only
 * what this section covers.
 */
export function TrustSection() {
  return (
    <section className="about-section trust" id={TRUST_SECTION_ID} aria-labelledby="trust-heading">
      <h2 className="about-heading" id="trust-heading">Trust &amp; compliance</h2>
      <p>
        How Questor meets the laws that govern AI in hiring, from our own reading of them. Each line says
        what the law asks, what Questor does, and whether that is in place, in progress or planned.
      </p>

      {TRUST_FRAMEWORKS.map((framework) => (
        <div key={framework.key} className="trust-framework">
          <h3 className="trust-framework-name">{framework.name}</h3>
          <p className="trust-framework-scope">{framework.scope}</p>
          <ul className="trust-items">
            {framework.items.map((item) => <TrustEntry key={item.key} item={item} />)}
          </ul>
        </div>
      ))}

      <div className="trust-framework">
        <h3 className="trust-framework-name">Security</h3>
        <p className="trust-framework-scope">Each measure below was checked in the running code before it was listed.</p>
        <ul className="trust-items">
          {TRUST_SECURITY.map((item) => <TrustEntry key={item.key} item={item} />)}
        </ul>
      </div>

      <div className="trust-framework">
        <h3 className="trust-framework-name">Data protection impact assessment, in short</h3>
        <dl className="trust-dpia">
          {DPIA_SUMMARY.map((part) => (
            <div key={part.heading} className="trust-dpia-part">
              <dt>{part.heading}</dt>
              {part.points.map((point) => <dd key={point}>{point}</dd>)}
            </div>
          ))}
        </dl>
      </div>

      <div className="trust-framework">
        <h3 className="trust-framework-name">Your data requests</h3>
        <PrivacyRequests />
      </div>

      <div className="trust-framework">
        <h3 className="trust-framework-name">Data sources and attribution</h3>
        <CatalogAttribution className="trust-attribution" />
      </div>

      <p className="trust-note">
        This describes how Questor is built; it is not legal advice, and our analysis has not yet been
        reviewed by a lawyer. The organisation running the hiring remains the employer and data controller
        under these laws.
      </p>
    </section>
  );
}
