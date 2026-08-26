import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { useChat } from '@/stores/chat';

interface Props {
  id: string;
  content: string;
  duration: number;
  active: boolean;
}

function Spinner() {
  return (
    <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
  );
}

export function ThinkingBlock({ id, content, duration, active }: Props) {
  const expanded = useChat((s) => !!s.expandedThinkingIds[id]);
  const toggle = useChat((s) => s.toggleThinking);

  if (active) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-muted mb-3">
        <ChevronRight size={14} />
        <span>Thinking…</span>
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => toggle(id)}
        className="flex items-center gap-2 text-sm text-text-muted hover:text-text-secondary"
      >
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="inline-flex"
        >
          <ChevronRight size={14} />
        </motion.span>
        <span>Thought for {duration}s</span>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="overflow-hidden"
          >
            {/* Capped and scrollable. A reasoning model can emit tens of
                thousands of characters of thinking, and unbounded that pushed
                the answer — the part the user actually wants — miles below the
                fold, with the scrollbar suggesting the reply itself was that
                long. */}
            <div className="mt-2 pl-3 border-l border-border-subtle text-sm text-text-muted whitespace-pre-wrap font-mono max-h-80 overflow-y-auto scrollbar-hide">
              {content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
