import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CoworkAvatar } from '@/components/chat/CoworkTranscriptPanel';
import { useArtifacts } from '@/stores/artifacts';
import { useBrowser } from '@/stores/browser';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useCoworkTeam } from '@/stores/coworkTeam';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
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

function TeamActivity({ teammateId }: { teammateId?: string }) {
  const roster = useCoworkTeam((s) => s.roster);
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const connected = useCinderpawStore((s) => s.isReady);
  const still = useReducedMotion();
  const teammates = roster.filter((a) => a.id !== teammateId).map((agent) => {
    const approval = exchanges.findLast((e) => e.kind === 'approval' && e.fromAgentId === agent.id && e.status === 'running');
    const related = exchanges.filter((e) => e.kind !== 'approval' && e.toAgentId === agent.id);
    const working = related.findLast((e) => e.status === 'running' && e.startedAt != null);
    const queued = related.findLast((e) => e.status === 'running');
    const recent = related.findLast((e) => e.status !== 'running');
    const status = !connected ? 'Disconnected' : approval ? 'Needs approval' :
      working ? 'Working' : queued ? 'Queued' : recent ? recent.status === 'error' ? 'Failed' : 'Done' : 'Available';
    const detail = (approval ?? working ?? queued)?.requestText ?? recent?.responseText ?? agent.role;
    return { agent, status, detail, priority: approval ? 4 : working ? 3 : queued ? 2 : recent ? 1 : 0 };
  }).sort((a, b) => b.priority - a.priority);
  if (teammates.length === 0) return null;

  return (
    <section aria-label="Team activity" className="rounded-[18px] bg-bg-elevated px-3.5 py-3">
      <h3 className="mb-2 flex items-center gap-2.5 text-sm font-medium text-text-primary">
        <Users size={16} className="text-text-secondary" aria-hidden /> Team activity
      </h3>
      <ul className="flex flex-col gap-0.5">
        {teammates.map(({ agent, status, detail }) => (
          <li key={agent.id}>
            <Link to={`/teammates/${encodeURIComponent(agent.id)}`} viewTransition={!still}
              state={{ focusTeammateComposer: true }}
              aria-label={`Open chat with ${agent.name}`}
              className="group flex min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-2 hover:bg-bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-brand">
              <CoworkAvatar id={agent.id} name={agent.name} className="size-8" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-text-primary">{agent.name}</span>
                  <span className={cn('shrink-0 text-2xs',
                    status === 'Working' || status === 'Needs approval' ? 'text-brand' :
                    status === 'Done' ? 'text-success' : 'text-text-muted')}>{status}</span>
                </div>
                {detail && <p className="truncate text-xs text-text-muted" title={detail}>{detail}</p>}
              </div>
              <ArrowUpRight size={14} aria-hidden className="shrink-0 text-text-muted group-hover:text-text-primary" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The Context cards as their own column beside the chat, like Claude's side
 * panel (his ask, 29 Oct): there by default, closable, and separate from
 * Artifacts. It floats over the right edge under the chat header, which never
 * moves; the conversation steps aside only as far as `contextShove` says.
 */
export function ContextColumn({ covered = false, onCompose, onAttach, teammateId }: {
  /** Under an open artifact: it stays in place, and is hidden once the panel has
   *  slid over it (MOTION.base), so it never fades out over the arriving panel. */
  covered?: boolean;
  onCompose?: (text: string) => void;
  onAttach?: () => void;
  teammateId?: string;
}) {
  const team = <TeamActivity teammateId={teammateId} />;
  if (teammateId !== undefined) {
    return (
      <aside aria-label="Context" className="hidden w-80 shrink-0 flex-col border-l border-border-default pt-3 lg:flex">
        <ContextTab onCompose={onCompose} onAttach={onAttach}>{team}</ContextTab>
      </aside>
    );
  }
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
      {/* No title and no X of its own: the header's Context button above opens
          and closes it, and a second close two inches away was a duplicate (Darius, 29 Oct). */}
      <ContextTab onCompose={onCompose} onAttach={onAttach}>{team}</ContextTab>
    </motion.aside>
  );
}
