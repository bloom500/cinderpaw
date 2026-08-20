/**
 * Root error boundary — last line of defense against render-time exceptions.
 *
 * Without this, any uncaught error thrown during render unmounts the entire
 * React tree and the user is left staring at a blank window with no way to
 * recover short of killing the process (audit finding: zero ErrorBoundary
 * in the app). This catches the error, shows what happened, and offers two
 * recoveries: re-render in place (cheap, works for transient state bugs) or
 * a full reload (resets all in-memory state; conversations are on disk).
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] render error:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-bg-primary text-text-primary px-8">
        <div className="text-5xl" aria-hidden>😿</div>
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-text-muted max-w-md text-center leading-relaxed">
          Feral hit an unexpected error while rendering. Your conversations are
          saved on disk and will be there after a reload.
        </p>
        <pre className="max-w-xl max-h-40 overflow-auto text-xs text-text-muted bg-bg-surface border border-border-default rounded-lg px-4 py-3 whitespace-pre-wrap">
          {error.message || String(error)}
        </pre>
        <div className="flex gap-3 mt-2">
          <button
            type="button"
            onClick={this.reset}
            className="text-sm font-medium px-4 py-2 rounded-lg border border-border-default hover:bg-bg-hover transition-colors"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-sm font-medium px-4 py-2 rounded-lg bg-brand text-on-brand hover:bg-brand/90 transition-colors"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
