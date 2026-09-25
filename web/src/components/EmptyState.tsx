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
  /**
   * Where this sits in the page's outline. Inside a page that has its own
   * title it is a section heading (the default). When the empty state IS the
   * page -- a refusal, a record that is gone, a role with no scorecard -- it is
   * the page's heading, and saying so is the difference between a screen
   * reader announcing what this screen is and announcing nothing at all.
   */
  heading?: 'page' | 'section';
}

/** What a list shows when there is nothing in it: what this is, what to do, and the button to do it. */
export function EmptyState({
  icon, title, message, illustration, illustrationWidth = 360, illustrationHeight = 360, action, compact,
  heading = 'section',
}: EmptyStateProps) {
  // h2, not h3: the title used to jump a level under the page's own h1, which
  // axe caught as `heading-order` on 17 screens. A heading level is the outline
  // a screen reader navigates by, not a size.
  const Heading = heading === 'page' ? 'h1' : 'h2';
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
      <Heading className="empty-title">{title}</Heading>
      <p className="empty-message">{message}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
