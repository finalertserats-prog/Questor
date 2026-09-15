export function Contact() {
  // Set VITE_SUPPORT_EMAIL at build time to publish a support address; nothing
  // is invented when it is absent.
  const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL as string | undefined;

  return (
    <div>
      <div className="topbar">
        <h1>Contact</h1>
      </div>
      <div className="card about-card">
        {supportEmail ? (
          <div>
            <div className="small muted">Support email</div>
            <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
          </div>
        ) : (
          <p className="muted">Contact your Questor administrator.</p>
        )}
      </div>
    </div>
  );
}
