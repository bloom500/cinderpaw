/**
 * ToolCallStack — vertical stack of up to 4 ToolCallBubble components,
 * positioned above the mascot in MascotPerch.
 *
 * The store caps the array at 4 entries; this component renders them in
 * order, oldest at the top. The container is fixed-width-ish (max-w-xs)
 * and non-interactive (pointer-events-none) because bubbles are
 * decorative in v1.
 */

import { AnimatePresence } from 'framer-motion';
import { ToolCallBubble } from './ToolCallBubble';
import type { ToolCallEvent } from '@/stores/chat';

export interface ToolCallStackProps {
  events: ToolCallEvent[];
  active: boolean;
}

export function ToolCallStack({ events, active }: ToolCallStackProps) {
  if (events.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute -top-2 left-full ml-2 z-20
                 flex flex-col-reverse items-start gap-1"
      data-active={active}
    >
      <AnimatePresence initial={false}>
        {events.map((e) =>
          e.kind === 'context' ? (
            <div
              key={e.id}
              role="status"
              aria-live="polite"
              className="pointer-events-none select-none
                         px-2 py-1 rounded-md text-[10px]
                         bg-bg-elevated border border-border-default
                         text-text-muted whitespace-nowrap"
            >
              {e.label}
            </div>
          ) : (
            <ToolCallBubble
              key={e.id}
              emoji={e.emoji}
              label={e.name}
              mainArg={e.mainArg}
              status={e.status}
              startedAt={e.startedAt}
              endedAt={e.endedAt}
            />
          ),
        )}
      </AnimatePresence>
    </div>
  );
}
