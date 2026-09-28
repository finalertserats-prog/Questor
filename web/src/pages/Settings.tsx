import { roleLabel } from '../components/inviteModel';
import { useAuth } from '../auth';
import { ThemeToggle } from '../components/theme';
import { Icon, type IconName } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { AtsConnectionPanel } from '../components/AtsConnectionPanel';
import { can } from '../components/capabilityModel';
import { DigestSetting } from '../components/hrbox/DigestSetting';
import { BusinessAreasPanel } from '../components/BusinessAreasPanel';
import { ChangePasswordPanel } from '../components/ChangePasswordPanel';
import { TrustedDevicesPanel } from '../components/TrustedDevicesPanel';

export function Settings() {
  const { user, tenant } = useAuth();

  const rows: Array<[string, string, IconName]> = [
    ['Name', user?.name ?? '—', 'candidate-profile'],
    ['Email', user?.email ?? '—', 'mail'],
    ['Role', user ? roleLabel(user.role) : '—', 'admin'],
    ['Organisation', tenant?.name ?? '—', 'team'],
  ];

  return (
    <div>
      <PageHeader icon="settings" title="Settings" />
      <div className="card settings-card">
        <dl className="settings-list">
          {rows.map(([label, value, icon]) => (
            <div key={label} className="settings-row">
              <dt className="small muted card-title"><Icon name={icon} size={14} />{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="settings-theme">
          <div className="small muted">Theme</div>
          <ThemeToggle />
        </div>
        {/* Only for someone the summary could be about: it lists candidates. */}
        {user && can(user, 'candidate:read') && <DigestSetting initialOptOut={user.digestOptOut ?? false} />}
      </div>
      {/* A demo visitor's account is a throwaway with a random password and an
          expiry; there is nothing there to change. */}
      {user && user.role !== 'demo' && <ChangePasswordPanel />}
      {user && user.role !== 'demo' && <TrustedDevicesPanel />}
      {/* The server refuses everyone else; hiding it just spares them a 403. */}
      {user?.role === 'admin' && <AtsConnectionPanel />}
      {/* Which part of the shared role catalog this organisation searches by
          default. Its own admin's to change, within a limit only Questor raises. */}
      {user?.role === 'admin' && <BusinessAreasPanel />}
    </div>
  );
}
