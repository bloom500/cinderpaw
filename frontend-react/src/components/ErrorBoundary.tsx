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
import { useLocation, useNavigate, useRouteError } from 'react-router-dom';

/**
 * One page broke, the rest of the app did not. The router catches a page's
 * render error before the boundary below can, and its own screen was a
 * developer page ("Hey developer") with no sidebar and no way back: one bad
 * reply from the engine on the Learning tab took the whole window with it.
 * Rendered inside the shell, so the sidebar stays and every other page works.
 */
export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  console.error('[RouteError]', error);
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <h1 className="text-lg font-semibold text-text-primary">This page stopped working</h1>
      <p className="text-sm text-text-muted max-w-md leading-relaxed">
        Something on it broke. Your chats and settings are safe. Try again, or go back to the chat.
      </p>
      <pre className="max-w-xl max-h-32 overflow-auto text-xs text-text-muted bg-bg-surface border border-border-default rounded-lg px-4 py-2 whitespace-pre-wrap">
        {message}
      </pre>
      <div className="flex gap-3 mt-1">
        {/* A navigation clears the router's error, so the same address is a retry. */}
        <button
          type="button"
          onClick={() => navigate(pathname + search, { replace: true })}
          className="text-sm font-medium px-4 py-2 rounded-lg border border-border-default hover:bg-bg-hover transition-colors"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => navigate('/chat')}
          className="text-sm font-medium px-4 py-2 rounded-lg bg-brand text-on-brand hover:bg-brand/90 transition-colors"
        >
          Go to chat
        </button>
      </div>
    </div>
  );
}

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
          Cinderpaw hit an unexpected error while rendering. Your conversations are
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
