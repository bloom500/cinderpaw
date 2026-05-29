import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { HfDetailPanel } from './HfDetailPanel';
import { StreamingIndicator } from '@/components/chat/StreamingIndicator';
import { fmtNum, fmtDate } from '@/lib/modelUtils';
import type { HfModelSummary, HfModelDetail } from '@/lib/tauri';

interface Props {
  model: HfModelSummary;
  expanded: boolean;
  detail: HfModelDetail | null;
  detailLoading: boolean;
  onExpand: (repoId: string) => void;
}

export function HfModelCard({ model, expanded, detail, detailLoading, onExpand }: Props) {
  const tags = model.tags.slice(0, 3).join(' · ');

  return (
    <div className="border border-border-default rounded-lg overflow-hidden bg-bg-surface">
      {/* Header row — always visible */}
      <button
        type="button"
        onClick={() => onExpand(model.id)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-bg-hover transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">{model.id}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-text-muted mt-0.5 flex-wrap">
            <span>⬇ {fmtNum(model.downloads)}</span>
            <span>♥ {model.likes}</span>
            <span>{fmtDate(model.last_modified)}</span>
            {tags && <><span>·</span><span className="truncate">{tags}</span></>}
          </div>
        </div>
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.18 }}
          className="text-text-muted shrink-0"
        >
          <ChevronRight size={16} />
        </motion.span>
      </button>

      {/* Expandable detail */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-border-subtle">
              {detailLoading || !detail ? (
                <div className="flex justify-center py-4">
                  <StreamingIndicator />
                </div>
              ) : (
                <HfDetailPanel repoId={model.id} detail={detail} loading={false} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
