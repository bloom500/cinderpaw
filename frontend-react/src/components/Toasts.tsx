/**
 * Global toast stack, drawn by Sileo (vendored in components/ui/sileo).
 *
 * Positioning lives in AppShell's NotificationLayer — the shared top-right
 * column under the window controls — so these and the update card stack in one
 * place. Each toast is Sileo's gooey pill: it opens like liquid into its
 * details and closes the same way (his pick, 24 Oct: "da vibeul ala de
 * premium"). Only the single-toast piece is used, not Sileo's Toaster, which
 * would put a second fixed column on top of this one.
 */

import { useEffect, useState } from 'react';
import { Sileo } from '@/components/ui/sileo/sileo';
import '@/components/ui/sileo/styles.css';
import { useNotifications, type Toast } from '@/stores/notifications';

/** The pill's colour: the app's solid surface for the theme. It must be
 *  opaque: the gooey filter sharpens alpha, and the glass tokens (24-34%)
 *  came out invisible, leaving bare text at the window's edge (24 Oct). */
const SOLID = { dark: 'rgb(52, 39, 31)', light: 'rgb(255, 253, 250)' } as const;
function useFill(): string {
  const read = () => (document.documentElement.getAttribute('data-theme') === 'light' ? SOLID.light : SOLID.dark);
  const [fill, setFill] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setFill(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => obs.disconnect();
  }, []);
  return fill;
}

const short = (s: string) => (s.length > 34 ? `${s.slice(0, 33).trimEnd()}…` : s);

function stateOf(t: Toast) {
  // The done toast (spec 7.4): something finished and can be opened.
  if (t.kind === 'success' && t.action) return 'action' as const;
  return t.kind;
}

/** `compact`: a native page fills the canvas and only the band above it is
 *  visible, so one toast shows (the newest) and says how many wait. */
export function Toasts({ compact = false }: { compact?: boolean }) {
  const all = useNotifications((s) => s.toasts);
  const dismiss = useNotifications((s) => s.dismiss);
  const fill = useFill();
  const toasts = compact ? all.slice(-1) : all;
  const waiting = all.length - toasts.length;

  return (
    // Sileo's width, to our 320 px column (its WIDTH constant says the same).
    <div className="flex flex-col items-end gap-2" role="status" aria-live="polite" style={{ '--sileo-width': '320px' } as React.CSSProperties}>
      {[...toasts].reverse().map((t) => (
        <div key={t.id} className="pointer-events-auto relative w-full">
          <Sileo
            id={t.id}
            state={stateOf(t)}
            // The pill fits about 34 characters; the rest of a long title is in the details.
            title={short(waiting > 0 ? `${t.title} (+${waiting} more)` : t.title)}
            description={t.message}
            position="right"
            expand="bottom"
            fill={fill}
            exiting={t.exiting}
            // A sticky toast (a scheduled task's result) stays open, details
            // shown, until the person closes it; the rest open and close by themselves.
            autoExpandDelayMs={t.message || t.action || t.sticky ? 150 : undefined}
            autoCollapseDelayMs={t.sticky ? undefined : 3000}
            button={
              t.action
                ? { title: t.action.label, onClick: () => { t.action!.run(); dismiss(t.id); } }
                : t.sticky
                  ? { title: 'Got it', onClick: () => dismiss(t.id) }
                  : undefined
            }
            onDismiss={() => dismiss(t.id)}
            // Sileo capitalises every word; our titles are sentences.
            styles={{ title: 'normal-case!' }}
          />
        </div>
      ))}
    </div>
  );
}
