import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface EmptyStateProps {
  icon: IconName;
  title: string;
  message: ReactNode;
  /** Optional artwork. Falls back to the icon if the image fails to load. */
  illustration?: string;
  action?: ReactNode;
  compact?: boolean;
}

/** What a list shows when there is nothing in it: what this is, what to do, and the button to do it. */
export function EmptyState({ icon, title, message, illustration, action, compact }: EmptyStateProps) {
  const [artFailed, setArtFailed] = useState(false);
  const showArt = !!illustration && !artFailed;

  return (
    <div className={compact ? 'empty-state compact' : 'empty-state'}>
      {showArt ? (
        <img className="empty-art" src={illustration} alt="" onError={() => setArtFailed(true)} />
      ) : (
        <span className="empty-icon"><Icon name={icon} size={compact ? 22 : 28} /></span>
      )}
      <h3 className="empty-title">{title}</h3>
      <p className="empty-message">{message}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
