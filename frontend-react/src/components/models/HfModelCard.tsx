import { useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, ChevronDown, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { HfDetailPanel } from './HfDetailPanel';
import { StreamingIndicator } from '@/components/chat/StreamingIndicator';
import { useDownload } from '@/stores/download';
import { useSystemInfo } from '@/stores/systemInfo';
import {
  fmtNum, fmtDate, sizeGb,
  pickFittedFile, compatLevel, globalFittedQuant,
  type Compat,
} from '@/lib/modelUtils';
import type { HfModelSummary, HfModelDetail } from '@/lib/tauri';

// ── Inline compat badge (no popover — just icon + label) ─────────────────────

function CompatBadge({ compat }: { compat: Compat }) {
  if (compat === 'fits') return (
    <span className="flex items-center gap-1 text-success text-xs font-medium">
      <CheckCircle size={11} /> Fits
    </span>
  );
  if (compat === 'slow') return (
    <span className="flex items-center gap-1 text-yellow-500 text-xs font-medium">
      <AlertTriangle size={11} /> May be slow
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-error text-xs font-medium">
      <XCircle size={11} /> Won't fit
    </span>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

interface Props {
  model: HfModelSummary;
  expanded: boolean;
  detail: HfModelDetail | null;
  detailLoading: boolean;
  onExpand: (repoId: string) => void;
  onRequestDetail: (repoId: string) => void;
}

export function HfModelCard({ model, expanded, detail, detailLoading, onExpand, onRequestDetail }: Props) {
  const sysInfo    = useSystemInfo((s) => s.info);
  const dlActive   = useDownload((s) => s.active);

  const shortName  = model.id.split('/').pop() ?? model.id;
  const author     = model.id.includes('/') ? model.id.split('/')[0] : '';
  const tags       = model.tags.slice(0, 3).join(' · ');

  // Stable quant based on hardware — shown immediately and stays consistent
  const estimatedQuant = globalFittedQuant(sysInfo);

  // Recommended file — recomputed when detail or sysInfo change
  const recommended = useMemo(
    () => (detail ? pickFittedFile(detail.gguf_files, sysInfo) : null),
    [detail, sysInfo],
  );
  const recSize   = recommended?.size ?? null;
  const recCompat = recSize ? compatLevel(recSize, sysInfo) : null;
  // Pill always shows the hardware-appropriate quant (stable, never jumps).
  // The actual downloaded file is determined by pickFittedFile internally.
  const displayQuant = estimatedQuant;

  const isThisDownloading = dlActive?.repoId === model.id;
  const dlProgress        = isThisDownloading ? (dlActive?.progress ?? 0) * 100 : 0;

  // When the pill is clicked before detail is loaded, remember to auto-download
  // once the recommended file becomes available.
  const pendingDownload = useRef(false);

  useEffect(() => {
    if (pendingDownload.current && recommended && !isThisDownloading) {
      pendingDownload.current = false;
      void useDownload.getState().start(model.id, recommended.rfilename);
    }
  }, [recommended, isThisDownloading, model.id]);

  const handleDownloadPill = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (recommended) {
      void useDownload.getState().start(model.id, recommended.rfilename);
    } else {
      // Detail not yet loaded — fetch silently (no expand) and auto-download when ready
      pendingDownload.current = true;
      onRequestDetail(model.id);
    }
  };

  return (
    <div className="border border-border-default rounded-xl overflow-hidden bg-bg-surface hover:border-border-hover transition-colors">

      {/* ── Header ── */}
      <div className="flex items-center gap-4 px-5 py-4">

        {/* Left: info */}
        <div className="flex-1 min-w-0">
          <span className="text-base font-semibold text-text-primary leading-snug block truncate">
            {shortName}
          </span>
          <div className="flex items-center gap-3 text-xs text-text-muted mt-1 flex-wrap">
            {author && <span className="text-text-muted/70">{author}</span>}
            <span>⬇ {fmtNum(model.downloads)}</span>
            <span>♥ {model.likes}</span>
            <span>{fmtDate(model.last_modified)}</span>
            {tags && <span className="text-text-disabled">· {tags}</span>}
          </div>
        </div>

        {/* Right: size + compat + download pill + variants toggle */}
        <div className="flex flex-col items-end gap-2 shrink-0">

          {/* Size + compat badge — visible once detail loads */}
          {recSize && recCompat && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">{sizeGb(recSize)}</span>
              <CompatBadge compat={recCompat} />
            </div>
          )}

          {/* Download pill */}
          {isThisDownloading ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-bg-elevated border border-border-default text-xs text-text-muted min-w-[140px]">
              <div className="flex-1 h-1 rounded-full bg-bg-hover overflow-hidden">
                <div
                  className="h-full bg-brand transition-all duration-300"
                  style={{ width: `${dlProgress}%` }}
                />
              </div>
              <span>{dlProgress.toFixed(0)}%</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={(e) => void handleDownloadPill(e)}
              disabled={dlActive !== null && !isThisDownloading}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-bg-elevated border border-border-default text-sm text-text-primary hover:bg-bg-hover hover:border-brand/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Download size={12} />
              <span>Download · {displayQuant}</span>
            </button>
          )}

          {/* Show / Hide variants */}
          <button
            type="button"
            onClick={() => onExpand(model.id)}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            {expanded ? 'Hide variants' : 'Show variants'}
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.18 }}>
              <ChevronDown size={12} />
            </motion.span>
          </button>
        </div>
      </div>

      {/* Download progress bar (full-width strip) */}
      {isThisDownloading && (
        <div className="h-0.5 bg-bg-elevated">
          <div
            className="h-full bg-brand transition-all duration-300"
            style={{ width: `${dlProgress}%` }}
          />
        </div>
      )}

      {/* ── Expandable variants ── */}
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
