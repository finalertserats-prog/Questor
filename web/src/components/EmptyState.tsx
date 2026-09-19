import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface EmptyStateProps {
  icon: IconName;
  title: string;
  message: ReactNode;
  /** Optional artwork. Falls back to the icon if the image fails to load. */
  illustration?: string;
  /**
   * The artwork's intrinsic size, so the browser reserves the right box before
   * it loads and the text below does not jump. The default suits the square
   * art; pass the real values for anything else.
   */
  illustrationWidth?: number;
  illustrationHeight?: number;
  action?: ReactNode;
  compact?: boolean;
}

/** What a list shows when there is nothing in it: what this is, what to do, and the button to do it. */
export function EmptyState({
  icon, title, message, illustration, illustrationWidth = 360, illustrationHeight = 360, action, compact,
}: EmptyStateProps) {
  const [artFailed, setArtFailed] = useState(false);
  // A previous illustration's failure must not hide a different one that may
  // load perfectly well.
  useEffect(() => { setArtFailed(false); }, [illustration]);
  const showArt = !!illustration && !artFailed;

  return (
    <div className={compact ? 'empty-state compact' : 'empty-state'}>
      {showArt ? (
        <img
          className="empty-art"
          src={illustration}
          alt=""
          width={illustrationWidth}
          height={illustrationHeight}
          onError={() => setArtFailed(true)}
        />
      ) : (
        <span className="empty-icon"><Icon name={icon} size={compact ? 22 : 28} /></span>
      )}
      <h3 className="empty-title">{title}</h3>
      <p className="empty-message">{message}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
