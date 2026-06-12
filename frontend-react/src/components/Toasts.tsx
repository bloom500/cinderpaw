/**
 * Global toast stack — renders `useNotifications` in the bottom-right corner.
 * Mounted once in AppShell so toasts survive page navigation.
 */

import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useNotifications, type ToastKind } from '@/stores/notifications';
import { cn } from '@/lib/utils';

const ICONS: Record<ToastKind, React.ReactNode> = {
  info:    <Info size={15} className="text-sky-400 shrink-0 mt-0.5" />,
  success: <CheckCircle2 size={15} className="text-emerald-400 shrink-0 mt-0.5" />,
  error:   <AlertCircle size={15} className="text-rose-400 shrink-0 mt-0.5" />,
};

export function Toasts() {
  const toasts = useNotifications((s) => s.toasts);
  const dismiss = useNotifications((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'flex items-start gap-2 rounded-lg border bg-bg-elevated shadow-lg px-3 py-2.5',
            t.kind === 'error' ? 'border-rose-500/40' : 'border-border-default',
          )}
        >
          {ICONS[t.kind]}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary">{t.title}</p>
            {t.message && (
              <p className="text-xs text-text-muted mt-0.5 leading-relaxed line-clamp-4 break-words">
                {t.message}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
            className="shrink-0 p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
