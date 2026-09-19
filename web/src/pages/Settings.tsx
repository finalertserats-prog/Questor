import { useAuth } from '../auth';
import { ThemeToggle } from '../components/theme';
import { Icon, type IconName } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { AtsConnectionPanel } from '../components/AtsConnectionPanel';
import { humanise } from '../components/statusModel';

export function Settings() {
  const { user, tenant } = useAuth();

  const rows: Array<[string, string, IconName]> = [
    ['Name', user?.name ?? '—', 'candidate-profile'],
    ['Email', user?.email ?? '—', 'mail'],
    ['Role', user ? humanise(user.role) : '—', 'admin'],
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
      </div>
      {/* The server refuses everyone else; hiding it just spares them a 403. */}
      {user?.role === 'admin' && <AtsConnectionPanel />}
    </div>
  );
}
