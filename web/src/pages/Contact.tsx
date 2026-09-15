import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';

export function Contact() {
  // Set VITE_SUPPORT_EMAIL at build time to publish a support address; nothing
  // is invented when it is absent.
  const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL as string | undefined;

  return (
    <div>
      <PageHeader icon="contact" title="Contact" />
      <div className="card about-card">
        {supportEmail ? (
          <div>
            <div className="small muted card-title"><Icon name="mail" size={14} />Support email</div>
            <a className="link-action" href={`mailto:${supportEmail}`}><Icon name="send" size={15} />{supportEmail}</a>
          </div>
        ) : (
          <EmptyState
            compact
            icon="contact"
            title="No support address published"
            message="Contact your Questor administrator."
          />
        )}
      </div>
    </div>
  );
}
