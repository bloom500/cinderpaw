import { useSyncExternalStore } from 'react';
import { X, Globe, FileText, Brain, TerminalSquare, Trash2 } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { useT } from '@/lib/i18n';
import { artifactsSnapshot, subscribeArtifacts, clearArtifacts } from '@/lib/callArtifacts';
import type { ToolActivity } from '@/hooks/useLiveToolActivity';

/**
 * Everything the call looked up, after the widgets have gone.
 *
 * The panel is an indicator and its rows age out in six seconds, which is right
 * for knowing that work is happening and wrong for keeping what the work found.
 * A spoken answer is the worst possible container for a URL: it is gone the
 * moment it is said, and the only way back to a page the agent read was to ask
 * it to search again.
 *
 * So the sources stay, and they are clickable. That is the whole feature —
 * a call stops being a conversation you cannot cite.
 */
export function CallArtifacts({ onClose }: { onClose: () => void }) {
  const t = useT();
  const items = useSyncExternalStore(subscribeArtifacts, artifactsSnapshot);

  return (
    <aside className="flex w-[24rem] shrink-0 flex-col border-l border-border-default bg-bg-surface pt-8">
      <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('call.artifactsClose')}
          title={t('call.artifactsClose')}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X size={16} />
        </button>
        <span className="text-sm font-medium text-text-primary">{t('call.artifacts')}</span>
        {items.length > 0 && (
          <button
            type="button"
            onClick={clearArtifacts}
            aria-label={t('call.artifactsClear')}
            title={t('call.artifactsClear')}
            className="ml-auto rounded p-1 text-text-muted hover:bg-bg-hover hover:text-rose-400"
          >
            <Trash2 size={14} />
          </button>
        )}
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
        {items.length === 0 ? (
          <p className="px-1 text-xs text-text-muted">{t('call.artifactsEmpty')}</p>
        ) : (
          items.map((a) => <Card key={a.id} a={a} />)
        )}
      </div>
    </aside>
  );
}

const ICON = {
  browser: Globe,
  files: FileText,
  memory: Brain,
  terminal: TerminalSquare,
} as const;

function Card({ a }: { a: ToolActivity }) {
  const Icon = ICON[a.kind as keyof typeof ICON] ?? Globe;
  const when = new Date(a.endedAt ?? a.startedAt);

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-elevated/50 p-2.5">
      <div className="flex items-center gap-2">
        <Icon size={12} className="shrink-0 text-text-muted" />
        <span className="truncate text-2xs text-text-secondary" title={a.subject}>
          {a.subject || a.tool}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-micro text-text-muted">
          {when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* The sources, as links that actually go somewhere. `open` hands the URL
          to the OS browser — the webview must not navigate away from the app,
          and a call in progress would die with it. */}
      {a.hits.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {a.hits.map((h) => (
            <li key={h.url}>
              <button
                type="button"
                onClick={() => void open(h.url)}
                title={h.url}
                className="block w-full text-left"
              >
                <span className="block truncate text-2xs text-[var(--result-link)] hover:underline">
                  {h.title}
                </span>
                <span className="block truncate text-micro text-text-muted">{h.host}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {a.facts.length > 0 && (
        <ul className="mt-2 space-y-1">
          {a.facts.map((f, i) => (
            <li key={i} className="rounded border border-violet-400/20 bg-violet-400/5 px-2 py-1 text-micro text-text-secondary">
              {f}
            </li>
          ))}
        </ul>
      )}

      {a.files.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {a.files.map((f) => (
            <li key={f.path} className="truncate text-micro text-text-muted" title={f.path}>
              {f.path}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
