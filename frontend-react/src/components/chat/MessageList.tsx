import { memo, useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  MessageScroller,
  useMessageScrollerScrollable,
} from '@shadcn/react/message-scroller';
import { useChat } from '@/stores/chat';
import { cn } from '@/lib/utils';
import { MessageItem, ReplyHead } from './MessageItem';
import { ChapterRail } from './ChapterRail';
import { useResendTurn } from '@/hooks/useResendTurn';
import { StreamingIndicator } from './StreamingIndicator';
import { ApprovalCard } from './ApprovalCard';
import { MetaProposalCard } from './MetaProposalCard';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { SYSTEM_FONT, useUI } from '@/stores/ui';
import { useChatDockHeight } from '@/lib/chatDock';

/**
 * The transcript, on shadcn's MessageScroller.
 *
 * The hand-rolled version followed the bottom on every frame, so a long reply
 * pushed your own question off the top while you were still reading the start
 * of the answer. The scroller anchors each of YOUR turns near the top and lets
 * the reply stream into the room below it; it follows the bottom only while you
 * are at the bottom, and a wheel, key or touch that moves away stops the follow.
 * Opening a saved chat lands on its latest turn.
 */
export function MessageList({ onFollowUp, onAnswer }: {
  /** A follow-up chip was picked: fill the composer with its words. */
  onFollowUp?: (text: string) => void;
  /** A next-step card was answered: send the answer. */
  onAnswer?: (text: string) => void;
} = {}) {
  const messages = useChat((s) => s.messages);
  // Rows that arrive together (a chat opened, history loaded) are already
  // there; only the one or two a turn adds should arrive. Animating fifty rows
  // at once on open cost frames and says nothing. Refs written during render:
  // idempotent, so a second StrictMode render changes nothing.
  const known = useRef(new Set<string>());
  const quiet = useRef(new Set<string>());
  const unseen = messages.filter((m) => !known.current.has(m.id));
  if (unseen.length > 2) for (const m of unseen) quiet.current.add(m.id);
  for (const m of unseen) known.current.add(m.id);
  // One resend for the whole transcript: the hooks it needs are called here,
  // once, not inside every row.
  const resend = useResendTurn();
  // Retry and Edit, one pair per message for as long as it is shown. Fresh
  // arrows on every render defeated MessageItem's memo, so anything that
  // re-rendered this list (opening a side panel, a cowork event) re-rendered
  // every message with its menus and tooltips. They look the row up when
  // pressed, so a stable pair still resends the right turn.
  const latest = useRef({ messages, resend });
  latest.current = { messages, resend };
  const actions = useRef(new Map<string, { retry: () => void; edit: (text: string) => void }>());
  const actionsFor = (id: string) => {
    let pair = actions.current.get(id);
    if (!pair) {
      // -1 while a reply is arriving: both drop everything below, that reply too.
      const at = () => (useChat.getState().streamStatus === 'streaming' ? -1 : latest.current.messages.findIndex((m) => m.id === id));
      pair = {
        retry: () => { const i = at(); if (i > 0) void latest.current.resend(i - 1); },
        edit: (text) => { const i = at(); if (i >= 0) void latest.current.resend(i, text); },
      };
      actions.current.set(id, pair);
    }
    return pair;
  };
  const status = useChat((s) => s.streamStatus);
  const agentPhase = useChat((s) => s.agentPhase);
  const agentTool = useChat((s) => s.agentTool);
  // Settings > Appearance > Chat font. Code keeps its own monospace face.
  const chatFont = useUI((s) => s.chatFont);
  const dockH = useChatDockHeight();

  // Approval requests belong to the chat they were raised in, as cards in its
  // transcript (spec 7.5). Other chats' requests reach the person through the
  // app-wide CoworkApprovalDock, which leaves this chat's to this list.
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const activeThreadId = useCoworkTranscript((s) => s.activeThreadId);
  const approvals = exchanges.filter((e) => e.kind === 'approval' && !!activeThreadId && e.threadId === activeThreadId);
  const last = messages[messages.length - 1];
  const hasActiveThinking = Boolean(last?.thinking && !last.thinkingComplete);
  const waitingForFirstToken = status === 'streaming' && last?.content === '' && !hasActiveThinking;
  // The logo head goes after the latest reply only: moving while it is being
  // written, still once there is a finished reply to sit under. Before the
  // first token it is the status line's icon instead, so it is drawn once.
  const head: 'writing' | 'still' | undefined =
    last?.role !== 'assistant' || waitingForFirstToken ? undefined
    : status === 'streaming' ? 'writing'
    : last.content.trim() ? 'still'
    : undefined;

  return (
    // scrollEdgeThreshold 24, not the library's 8 (28 Oct, Darius: "Jump to
    // bottom" stayed at the bottom). The scroller counts each row's 8 px of
    // paint room (`-my-2 py-2` on Row) as content, so at the very bottom it
    // saw exactly 8 px left; any fraction of a pixel (the composer measured at
    // 121.3 px) tipped it over the threshold and the button never went away.
    <MessageScroller.Provider autoScroll defaultScrollPosition="last-anchor" scrollEdgeThreshold={24}>
      {/* The root is the positioning context and is NOT the element that
          scrolls: an absolute child of a scroll container is laid out against
          the scrolled content, so "Jump to bottom" used to ride up and out of
          view with the transcript. */}
      <MessageScroller.Root className="h-full relative">
        {/* No `scroll-smooth`: programmatic follow on every streamed frame
            turns into overlapping animations, visible jank on long chats.
            No scroll anchoring either (28 Oct, Darius: "sare la fiecare
            token"): the scroller places the scroll and the room below your
            question itself, and the browser's anchoring moved it again on every
            line; the two corrected each other, 28 px down and back. Measured on
            this list, one reply: 29 scroll moves, 14 of them backwards; with
            anchoring off, 4 and 1. */}
        <MessageScroller.Viewport aria-label="Conversation" className="@container overflow-y-auto overscroll-contain thin-scrollbar outline-hidden [overflow-anchor:none]"
          // The Context cards' step aside is padding here (ChatPage sets
          // --cards-shove), so the column moves and the scrollbar stays at the edge.
          style={{ height: `calc(100% - ${dockH ?? 192}px)`, minHeight: 0, paddingRight: 'var(--cards-shove, 0px)' }}>
          {/* The viewport ends above the measured dock; text cannot scroll
              underneath the composer or its mascot. */}
          {/* 748 = the spec's 700 px reading column plus the 24 px gutters. */}
          <MessageScroller.Content
            // ChatPage glides this column when a side panel moves it.
            data-reading-column=""
            data-replying={status === 'streaming' ? '' : undefined}
            className="max-w-[748px] mx-auto px-6 py-6 flex flex-col gap-7"
            style={{
              paddingBottom: '48px',
              ...(chatFont === 'system' ? { fontFamily: SYSTEM_FONT } : {}),
            }}
          >
            {messages.map((m, i) => (
              <Row
                key={m.id}
                message={m}
                quiet={quiet.current.has(m.id)}
                streaming={status === 'streaming' && i === messages.length - 1 && m.role === 'assistant'}
                head={i === messages.length - 1 ? head : undefined}
                onFollowUp={i === messages.length - 1 && m.role === 'assistant' ? onFollowUp : undefined}
                onAnswer={i === messages.length - 1 && m.role === 'assistant' ? onAnswer : undefined}
                // Retry under a reply resends the question above it; Send under
                // an edited question resends that one. Both drop everything
                // below, which is why they are off while a reply is arriving:
                // hidden by `data-replying` below and refused in actionsFor.
                // Not taken away: that drew every row twice per reply (26 Oct).
                onRetry={m.role !== 'assistant' || i === 0 ? undefined : actionsFor(m.id).retry}
                onEdit={m.role !== 'user' ? undefined : actionsFor(m.id).edit}
              />
            ))}
            {approvals.map((e) => <ApprovalCard key={e.id} e={e} />)}
            {/* L6 asks here before it changes how Cinderpaw practices. */}
            <MetaProposalCard />
            {waitingForFirstToken && (
              <StreamingIndicator phase={agentPhase ?? 'thinking'} tool={agentTool} icon={<ReplyHead writing />} />
            )}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
        {/* Keyed by the chat's first message: kept across a chat switch, it
            counted the opened chat's whole length as arrivals ("↓ 22 new" on
            yesterday's chat, 28 Oct). A new chat starts counting from zero. */}
        <JumpToBottom key={messages[0]?.id ?? 'empty'} count={messages.length} />
        {/* Qwen-style chapter rail: one tick per user turn, with a popup list. */}
        <ChapterRail />
      </MessageScroller.Root>
    </MessageScroller.Provider>
  );
}

/**
 * One message in the transcript. Memoized as a whole, scroller item included:
 * every streamed frame re-renders the list, and drawing every row's item to
 * reach MessageItem's own memo cost ~14 ms a frame at 300 turns (26 Oct,
 * Edge, production build): a long chat streamed at 30 fps. Now an unchanged
 * row is one props compare.
 *
 * `contain: layout paint` keeps the browser's own per-frame pass out of rows
 * that did not change; without it, the growing reply had it walk every code
 * block and table of the chat (~20 ms a frame at 300 turns). The row is always
 * laid out, never sized by a guess as content-visibility did (removed 6 Oct,
 * test/scroll-stability.test.ts). Paint is clipped at the row's edge, so the
 * row reaches 16px past its content on each side and 8px above and below
 * (actions pulled left, card shadows, the chain's mascot), and anything that
 * must leave the row (the image viewer) is drawn in a portal.
 */
const Row = memo(function Row({ message: m, quiet, ...item }: ComponentProps<typeof MessageItem> & { quiet: boolean }) {
  return (
    // A message arrives, it does not blink into existence. Keyed on the id so
    // only genuinely new rows animate; a streamed token must never replay it.
    <MessageScroller.Item
      messageId={m.id}
      scrollAnchor={m.role === 'user'}
      className={cn(
        'message-row [contain:layout_paint] -mx-4 px-4 -my-2 py-2',
        !quiet && (m.role === 'user'
          // Yours rises out of the composer's corner: it came from there.
          ? 'animate-in fade-in-0 slide-in-from-bottom-4 zoom-in-95 origin-bottom-right duration-(--motion-slow)'
          : 'animate-in fade-in-0 slide-in-from-bottom-2 duration-(--motion-base)'),
        // The tool widgets inside an old row are already there too. Their entrances
        // replayed on every open: 245 at once in a 52-message chat (30 Oct).
        quiet && '[&_:is(.tw-rise,.tw-row,.tw-pop,.tw-type)]:animate-none',
      )}
    >
      <MessageItem message={m} {...item} />
    </MessageScroller.Item>
  );
});

/**
 * Shown only while there is transcript below the fold, with how many messages
 * arrived while you were up there. Offset by the composer's MEASURED height
 * (lib/chatDock.ts, published by ChatPage): a flat 80px was right for a
 * one-line draft and hidden behind a three-line one.
 */
function JumpToBottom({ count }: { count: number }) {
  const { end: below } = useMessageScrollerScrollable();
  const seen = useRef(count);
  const [unread, setUnread] = useState(0);
  const dockH = useChatDockHeight();

  useEffect(() => {
    if (!below) {
      seen.current = count;
      setUnread(0);
    } else if (count > seen.current) {
      setUnread(count - seen.current);
    }
  }, [below, count]);

  return (
    <MessageScroller.Button
      direction="end"
      render={(props, state) =>
        state.active ? (
          <button
            {...props}
            // Centred on the reading column, which the Context cards push left.
            style={{ bottom: `${Math.max(0, (dockH ?? 192) - 48)}px`, left: 'calc((100% - var(--cards-shove, 0px)) / 2)' }}
            className="absolute -translate-x-1/2 z-10 rounded-full bg-(--surface-typing) text-text-primary text-xs px-3 py-1.5 shadow-sm hover:bg-bg-hover flex items-center gap-1.5 border border-border-default"
          >
            ↓ {unread > 0 ? `${unread} new` : 'Jump to bottom'}
          </button>
        ) : null
      }
    />
  );
}
