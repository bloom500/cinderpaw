/**
 * ToolCallStack — vertical stack of up to 4 ToolCallBubble components,
 * positioned above the mascot in MascotPerch.
 *
 * The store caps the array at 4 entries; this component renders them in
 * order, oldest at the top. The container ignores pointer events, but
 * finished tool bubbles re-enable them so their output can be expanded
 * with a click (#18).
 */

import { AnimatePresence } from 'framer-motion';
import { ToolCallBubble } from './ToolCallBubble';
import { useChat } from '@/stores/chat';
import type { ToolCallEvent } from '@/stores/chat';

export interface ToolCallStackProps {
  events: ToolCallEvent[];
  active: boolean;
}

export function ToolCallStack({ events, active }: ToolCallStackProps) {
  if (events.length === 0) return null;
  return (
    <div
      // Anchored ABOVE the mascot and growing upward (column-reverse from
      // the bottom edge), so the stack can never extend down over the
      // typing bar no matter how many bubbles are visible.
      className="pointer-events-none absolute bottom-full mb-1 left-full ml-2 z-20
                 flex flex-col items-start gap-1"
      data-active={active}
    >
      <AnimatePresence initial={false}>
        {events.map((e) =>
          e.kind === 'worker' ? (
            // A background worker spawned by the notebook's `rlm()`. Same
            // bubble as a tool call because it reads the same way — a thing
            // that started, is taking time, and will end — but its own kind:
            // it outlives the turn, and tool-retry notes must not land on it.
            <ToolCallBubble
              key={e.id}
              emoji="🐝"
              label="worker"
              // The registry name (`subagent-count-the-files-a1b2`) is a
              // machine selector; the id tail is enough to tell two apart.
              mainArg={e.id}
              status={e.status}
              startedAt={e.startedAt}
              endedAt={e.endedAt}
              progressNote={e.detail}
              resultPreview={e.status !== 'running' ? e.detail : null}
            />
          ) : e.kind === 'context' ? (
            <div
              key={e.id}
              role="status"
              aria-live="polite"
              className="pointer-events-none select-none
                         px-2 py-1 rounded-md text-micro
                         bg-bg-elevated border border-border-default
                         text-text-muted whitespace-nowrap"
            >
              {e.label}
            </div>
          ) : e.kind === 'cowork' ? (
            // One agent-to-agent exchange (Agent Cowork). Reads like a tool
            // call — started, took time, ended — but the label is the A2A
            // conversation line and the preview is the agent's answer.
            // S4: while an approval is pending the bubble carries the
            // decision itself — Approve/Deny, answerable where the user
            // already is.
            <ToolCallBubble
              key={e.id}
              emoji="🤝"
              label={e.title}
              mainArg={null}
              status={e.status}
              startedAt={e.startedAt}
              endedAt={e.endedAt}
              resultPreview={e.detail}
              errorMessage={e.status === 'error' ? e.detail : null}
              actions={
                e.approval && e.status === 'running' ? (
                  <div
                    role="group"
                    aria-label={`Approval request: ${e.approval.description}`}
                    className="pointer-events-auto mt-1 flex items-center gap-1"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        useChat.getState().resolveCoworkApproval(e.approval!.requestId, true)
                      }
                      className="text-micro px-1.5 py-0.5 rounded bg-brand/15 border border-brand/40 hover:bg-brand/25 text-text-primary"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        useChat.getState().resolveCoworkApproval(e.approval!.requestId, false)
                      }
                      className="text-micro px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/40 hover:bg-red-500/20 text-text-primary"
                    >
                      Deny
                    </button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <ToolCallBubble
              key={e.id}
              emoji={e.emoji}
              label={e.name}
              mainArg={e.mainArg}
              status={e.status}
              startedAt={e.startedAt}
              endedAt={e.endedAt}
              resultPreview={e.resultPreview}
              errorMessage={e.errorMessage}
              progressNote={e.progressNote}
            />
          ),
        )}
      </AnimatePresence>
    </div>
  );
}
