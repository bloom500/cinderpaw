/**
 * Global toast stack.
 *
 * Positioning lives in AppShell's NotificationLayer — the shared top-right
 * column under the window controls — so these cards and the update card stack
 * in one place instead of two `fixed` containers fighting over the same corner.
 *
 * Behaviour is modelled on macOS notifications: slide in from the right, settle
 * with a spring, newest on top, close button revealed on hover.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { X, Check, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useNotifications, type ToastKind } from '@/stores/notifications';
import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo.svg';

const ICONS: Record<ToastKind, React.ReactNode> = {
  info:    <Info size={14} className="text-info shrink-0 mt-0.5" />,
  success: <CheckCircle2 size={14} className="text-success shrink-0 mt-0.5" />,
  error:   <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />,
};

/** `compact`: a native page fills the canvas and only the band above it is
 *  visible, so one card shows (the newest, one line) and says how many wait. */
export function Toasts({ compact = false }: { compact?: boolean }) {
  const all = useNotifications((s) => s.toasts);
  const toasts = compact ? all.slice(-1) : all;
  const waiting = all.length - toasts.length;
  const dismiss = useNotifications((s) => s.dismiss);

  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          // The done toast (spec 7.4, canvas): something finished and can be
          // opened. The head peeks over its top edge; Open is the button.
          const done = t.kind === 'success' && !!t.action;
          return (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 24, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24, scale: 0.96, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
            className={cn(
              'group pointer-events-auto relative flex items-start gap-2 rounded-xl border px-3 py-2.5',
              // Glass: a blurred, semi-opaque slab, a faint top-lit sheen, and a
              // 1px inner ring for the lit edge real glass has. Without the ring
              // the card reads as flat translucent plastic.
              'bg-bg-elevated/80 backdrop-blur-xl backdrop-saturate-150',
              'shadow-xl shadow-black/25 ring-1 ring-inset ring-white/10',
              'before:absolute before:inset-0 before:rounded-xl before:pointer-events-none',
              'before:bg-linear-to-b before:from-white/6 before:to-transparent',
              t.kind === 'error' ? 'border-error/40' : 'border-border-default/60',
              done && 'mt-7 items-center gap-3 rounded-2xl bg-bg-elevated px-3.5 py-3',
            )}
          >
            {done && <img src={logoUrl} alt="" className="pointer-events-none absolute -top-7 right-14 h-9 w-9" />}
            {done ? (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                <Check size={16} />
              </span>
            ) : ICONS[t.kind]}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {t.title}
                {waiting > 0 && <span className="ml-1.5 text-xs font-normal text-text-muted">+{waiting} more</span>}
              </p>
              {t.message && (
                <p className={cn('text-xs text-text-muted mt-0.5 leading-relaxed wrap-break-word', compact ? 'line-clamp-1' : 'line-clamp-4')}>
                  {t.message}
                </p>
              )}
            </div>
            {t.action && (
              <button
                type="button"
                onClick={() => { t.action!.run(); dismiss(t.id); }}
                className={done
                  ? 'h-8 shrink-0 self-center rounded-lg bg-brand px-3.5 text-sm font-medium text-brand-foreground hover:bg-brand/90'
                  : 'shrink-0 self-center rounded-md px-2 py-1 text-xs font-semibold text-brand hover:bg-bg-hover'}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              // Revealed on hover like a macOS notification, but always present
              // for keyboard and screen-reader users.
              className={cn(
                'shrink-0 p-0.5 rounded text-text-muted hover:bg-bg-hover hover:text-text-secondary',
                done ? 'self-center' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity',
              )}
            >
              <X size={14} />
            </button>
          </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
