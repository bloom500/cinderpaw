import { ReactNode } from 'react';

/**
 * Layout shell for the Agents tab.
 *
 * The previous version mounted a dedicated `ModelSelector` sidebar here on
 * top of the global AppShell sidebar. That second sidebar was redundant
 * — the agent header already shows the loaded model via `ModelPill`, and
 * the model picker lives in the global Models tab. The Agents tab is now
 * single-column, just like Chat.
 *
 * This component is kept as a thin wrapper so that any page-level
 * Agents-specific layout (error boundaries, focus traps, etc.) can be
 * added here later without touching every call site.
 */
interface Props {
  children?: ReactNode;
}

export function AgentsPageLayout({ children }: Props) {
  return <>{children}</>;
}
