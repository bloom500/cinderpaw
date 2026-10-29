import { motion } from 'framer-motion';
import { ArtifactClose } from '@/components/ai-elements/artifact';
import { useArtifacts } from '@/stores/artifacts';
import { useBrowser } from '@/stores/browser';
import { useUI } from '@/stores/ui';
import { cn } from '@/lib/utils';
import { ContextTab } from './ContextTab';
import { BASE } from '@/lib/motion';

/** A column of cards, not a resizable sheet. */
const WIDTH = 320;
/**
 * Room left free at the right edge for the transcript's scrollbar and chapter
 * rail (right 14px + 20px wide), so they stay at the edge, where they are with
 * the cards closed. They used to step left beside the cards (his "loose
 * screws", 29 Oct: "para de scroll se muta si ea la stanga").
 */
const SCROLL_LANE = 40;
/** What the cards take from the right edge: their width, the scroll lane and a gap. */
export const CONTEXT_SPAN = WIDTH + SCROLL_LANE + 8;
/** The transcript's reading column (MessageList max-w-[748px]). */
const READING_WIDTH = 748;
/** The narrowest chat worth keeping beside the cards; below it they stay away. */
const CHAT_MIN = 448;

/**
 * How far the conversation steps left so the cards never cover it, and no
 * further (his Claude comparison, 29 Oct: Claude moves its chat a few pixels,
 * we moved ours ~170 and the header with it). Zero while the reading column
 * and the cards fit side by side; at most the cards' own span. `null` when
 * the chat is too narrow to keep the cards beside it at all.
 */
export function contextShove(chatWidth: number): number | null {
  if (chatWidth < CHAT_MIN + CONTEXT_SPAN) return null;
  return Math.min(CONTEXT_SPAN, Math.max(0, READING_WIDTH + 2 * CONTEXT_SPAN - chatWidth));
}

/**
 * Whether the Context cards are on screen: open (the person's choice, kept
 * across restarts), and not covered by Artifacts or the browser, which come
 * over them and give them back when they close.
 */
export function useContextVisible(): boolean {
  const open = useUI((s) => s.contextOpen);
  const covered = useArtifacts((s) => s.panelOpen && s.panelTab !== 'context');
  const browsing = useBrowser((s) => s.panelOpen);
  return open && !covered && !browsing;
}

/**
 * The Context cards as their own column beside the chat, like Claude's side
 * panel (his ask, 29 Oct): there by default, closable, and separate from
 * Artifacts. It floats over the right edge under the chat header, which never
 * moves; the conversation steps aside only as far as `contextShove` says.
 */
export function ContextColumn({ covered = false, onCompose, onAttach }: {
  /** Under an open artifact: it stays in place, and is hidden once the panel has
   *  slid over it (MOTION.base), so it never fades out over the arriving panel. */
  covered?: boolean;
  onCompose?: (text: string) => void;
  onAttach?: () => void;
}) {
  return (
    <motion.aside
      aria-label="Context"
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 24, opacity: 0 }}
      transition={BASE}
      style={{ width: WIDTH, right: SCROLL_LANE }}
      // A wall for Cubby: thrown at the cards, it lands against them instead of
      // flying through (MascotPerch reads every data-mascot-wall).
      data-mascot-wall=""
      // top-[68px]: under the chat header (h-15, 60px) with a small gap, so
      // the header and its buttons stay exactly where they were.
      // Hidden only after the panel's slide (MOTION.base), shown again at once: the
      // panel leaving is what reveals it.
      className={cn(
        'absolute bottom-3 top-[68px] z-30 flex flex-col overflow-hidden transition-[visibility] duration-0',
        covered ? 'invisible delay-200' : 'delay-0',
      )}
      inert={covered}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-1">
        <h2 className="text-sm font-medium text-text-secondary">Context</h2>
        <ArtifactClose onClick={() => useUI.getState().setContextOpen(false)} aria-label="Close context" />
      </div>
      <ContextTab onCompose={onCompose} onAttach={onAttach} />
    </motion.aside>
  );
}
