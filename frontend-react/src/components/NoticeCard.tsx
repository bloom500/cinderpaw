import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The one shape every notice takes (Darius, 21 Oct: "cu toate sus"): an icon,
 * a title, one line, the buttons on the right, an X. They all appear in the
 * same top-right column (AppShell's NotificationLayer), one at a time
 * (lib/attention), so the eye learns the place once.
 */
export function NoticeCard({ icon: Icon, title, line, onClose, children, actions }: {
  icon: LucideIcon;
  title: string;
  line: ReactNode;
  /** No X while closing would lose something, e.g. an update installing. */
  onClose?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <motion.div
      // Slides in from the right like the toasts it shares a column with.
      initial={{ opacity: 0, x: 24, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
      // Same glass as the toasts (see Toasts.tsx): blurred slab, top-lit
      // sheen, 1px inner ring for the lit edge.
      className={cn(
        'pointer-events-auto relative w-full rounded-xl border border-border-default/60 p-4',
        'bg-bg-elevated/80 backdrop-blur-xl backdrop-saturate-150',
        'shadow-xl shadow-black/25 ring-1 ring-inset ring-white/10',
        'before:absolute before:inset-0 before:rounded-xl before:pointer-events-none',
        'before:bg-linear-to-b before:from-white/6 before:to-transparent',
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--bubble-user) text-brand">
          <Icon size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          <p className="text-2xs leading-relaxed text-text-muted">{line}</p>
          {children}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss"
            className="shrink-0 text-text-muted/60 hover:text-text-muted transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {actions && <div className="mt-3 flex justify-end gap-2">{actions}</div>}
    </motion.div>
  );
}

/** The two buttons a notice can end with, styled once for all of them. */
export function NoticeButton({ primary, onClick, children }: { primary?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-md text-xs transition-colors',
        primary ? 'bg-brand font-medium text-on-brand hover:opacity-90' : 'text-text-secondary hover:bg-bg-hover',
      )}
    >
      {children}
    </button>
  );
}
