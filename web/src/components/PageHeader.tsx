import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface PageHeaderProps {
  icon: IconName;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Sits beside the title, e.g. a status badge. */
  badge?: ReactNode;
  actions?: ReactNode;
}

/** The page title bar: an icon tile, the title, and the page's own actions on the right. */
export function PageHeader({ icon, title, subtitle, badge, actions }: PageHeaderProps) {
  return (
    <div className="topbar">
      <div className="page-title">
        <span className="page-icon"><Icon name={icon} size={20} /></span>
        <div className="page-title-text">
          <div className="page-title-line">
            <h1>{title}</h1>
            {badge}
          </div>
          {subtitle && <div className="muted small">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="row page-actions">{actions}</div>}
    </div>
  );
}
