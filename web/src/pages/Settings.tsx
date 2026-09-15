import { useAuth } from '../auth';
import { ThemeToggle } from '../components/theme';

export function Settings() {
  const { user, tenant } = useAuth();

  const rows: Array<[string, string]> = [
    ['Name', user?.name ?? '—'],
    ['Email', user?.email ?? '—'],
    ['Role', user?.role ?? '—'],
    ['Organisation', tenant?.name ?? '—'],
  ];

  return (
    <div>
      <div className="topbar">
        <h1>Settings</h1>
      </div>
      <div className="card settings-card">
        <dl className="settings-list">
          {rows.map(([label, value]) => (
            <div key={label} className="settings-row">
              <dt className="small muted">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="settings-theme">
          <div className="small muted">Theme</div>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
