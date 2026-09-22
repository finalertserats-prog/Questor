import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Icon } from './Icon';
import { boundaryCopy, type BoundaryScope } from './errorBoundaryModel';

/**
 * Keeps one fault from blanking the app. At the root it catches anything the
 * shell itself throws; around each page (keyed by the address, so moving to
 * another page clears it) it keeps the sidebar and the rest of the console
 * usable while that one page shows a way out.
 *
 * A class because React offers error boundaries only as class components;
 * there is no hook for getDerivedStateFromError.
 *
 * The recovery screen never shows the error itself: a stack trace means
 * nothing to the person reading it and can name internals. React still
 * reports the caught error to the console for whoever is debugging.
 */

interface Props {
  readonly children: ReactNode;
  readonly scope: BoundaryScope;
  /** Where "go home" leads; null leaves it out (a candidate has no dashboard). */
  readonly homeHref?: string | null;
  /** When this changes, a caught fault is cleared and the children render again. */
  readonly resetKey?: string;
}

interface State {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Nothing further: there is no client error reporting to send this to yet,
    // and React has already written it to the console.
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  private retry = () => this.setState({ failed: false });

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const copy = boundaryCopy(this.props.scope);
    const homeHref = this.props.homeHref === undefined ? '/' : this.props.homeHref;
    return (
      <div className={this.props.scope === 'app' ? 'fault-screen center-screen' : 'fault-screen'} role="alert">
        <div className="fault-panel">
          <h1 className="fault-title"><Icon name="alert" size={20} />{copy.title}</h1>
          <p className="fault-body">{copy.body}</p>
          <div className="fault-actions">
            <button type="button" className="btn" onClick={this.retry}><Icon name="refresh" size={16} />Try again</button>
            {homeHref && <a className="btn secondary" href={homeHref}>{copy.homeLabel}</a>}
          </div>
        </div>
      </div>
    );
  }
}
