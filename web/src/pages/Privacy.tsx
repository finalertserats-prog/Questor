import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { TRUST_SECTION_ID } from '../components/trustModel';
import {
  DATA_RECIPIENTS, PRIVACY_SECTIONS, contactSentence, supportContact, type PrivacySection,
} from '../components/privacyModel';

/**
 * The public privacy page.
 *
 * Until this existed there was no privacy page and no terms anywhere in the
 * product, nothing linked to one, and the consent checkbox referenced none
 * (legal review pack, question 31) — so a candidate agreed to an AI interview
 * with no document to read about what happens to what they say. It is public
 * and linked from the sign-in footer, the consent screen, the portal and the
 * About page, because a page a candidate cannot reach is not a notice.
 *
 * Its words come from privacyModel.ts, which the About page's trust section
 * reads too, so the two surfaces cannot tell a candidate different things
 * about who receives what.
 */

function Section({ section }: { readonly section: PrivacySection }) {
  return (
    <section className="about-section" aria-labelledby={`privacy-${section.key}`}>
      <h2 className="about-heading" id={`privacy-${section.key}`}>{section.heading}</h2>
      {section.paragraphs.map((text) => <p key={text}>{text}</p>)}
      {section.points && (
        <ul className="privacy-points">
          {section.points.map((point) => <li key={point}>{point}</li>)}
        </ul>
      )}
    </section>
  );
}

/** Everyone outside Questor and the hiring organisation who receives anything. */
function Recipients() {
  return (
    <ul className="privacy-recipients">
      {DATA_RECIPIENTS.map((r) => (
        <li key={r.key} className="privacy-recipient">
          <p className="privacy-recipient-who">{r.who}</p>
          <p className="privacy-recipient-line"><span className="privacy-recipient-label">What they receive: </span>{r.what}</p>
          <p className="privacy-recipient-line"><span className="privacy-recipient-label">When: </span>{r.when}</p>
        </li>
      ))}
    </ul>
  );
}

export function Privacy() {
  const contact = supportContact(import.meta.env.VITE_SUPPORT_EMAIL as string | undefined);
  return (
    <div>
      <PageHeader icon="about" title="Privacy" />
      <div className="card">
        <p className="about-lede">
          What Questor collects when you take an interview, why, how long it is kept, who else sees it,
          and how to ask for a copy or for it to be deleted. Written for candidates.
        </p>

        {PRIVACY_SECTIONS.map((section) => (
          <div key={section.key}>
            <Section section={section} />
            {/* The recipients belong inside "who it is shared with", where the
                section's last paragraph introduces them. */}
            {section.key === 'shared' && <Recipients />}
            {section.key === 'ask' && (
              <p className="privacy-contact">
                {contactSentence(contact)}
                {contact && <> <a href={`mailto:${contact}`}>{contact}</a></>}
              </p>
            )}
          </div>
        ))}

        <section className="about-section">
          <h2 className="about-heading">More detail</h2>
          <p>
            <Link to={`/about#${TRUST_SECTION_ID}`}>How Questor meets the laws that govern AI in hiring</Link>
            {' '}sets out, law by law, what each one asks, what Questor does, and whether that is in place,
            in progress or planned.
          </p>
        </section>

        <p className="trust-note">
          This describes how Questor is built; it is not legal advice, and our analysis has not yet been
          reviewed by a lawyer. The organisation running the hiring remains the employer and data
          controller under these laws.
        </p>
      </div>
    </div>
  );
}
