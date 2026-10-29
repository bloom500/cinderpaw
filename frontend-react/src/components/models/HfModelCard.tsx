import { useMemo, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Download, ChevronDown, Heart, Loader2, Monitor } from 'lucide-react';
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
import { BTN_PRIMARY, CARD, Chip, MakerTile, makerFor, paramsOf } from './ui';
import { cn } from '@/lib/utils';
import { BASE, FAST } from '@/lib/motion';

const COMPAT: Record<Compat, { label: string; cls: string }> = {
  fits: { label: 'Fits your hardware', cls: 'text-success' },
  slow: { label: 'May be slow here', cls: 'text-warning' },
  no:   { label: 'Too big for this machine', cls: 'text-error' },
};

/** Hub tags a person would recognise, in plain words. */
const TAG_LABELS: Record<string, string> = {
  'text-generation': 'Text generation',
  conversational: 'Chat',
  'feature-extraction': 'Embeddings',
  'sentence-similarity': 'Embeddings',
  'image-text-to-text': 'Vision',
  'image-to-text': 'Vision',
  'automatic-speech-recognition': 'Speech-to-text',
  'text-to-speech': 'Text-to-speech',
  'text-to-image': 'Text-to-image',
  multilingual: 'Multilingual',
  code: 'Code',
};

function tagLabels(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const l = TAG_LABELS[t.toLowerCase()];
    if (l && !out.includes(l)) out.push(l);
  }
  return out.slice(0, 2);
}

interface Props {
  model: HfModelSummary;
  expanded: boolean;
  /** Its files are being fetched before it opens. */
  opening: boolean;
  detail: HfModelDetail | null;
  onExpand: (repoId: string) => void;
  onRequestDetail: (repoId: string) => void;
}

export function HfModelCard({ model, expanded, opening, detail, onExpand, onRequestDetail }: Props) {
  const sysInfo    = useSystemInfo((s) => s.info);
  const dlActive   = useDownload((s) => s.active);

  const shortName  = model.id.split('/').pop() ?? model.id;
  const author     = model.id.includes('/') ? model.id.split('/')[0] : '';
  const maker      = makerFor(shortName) ?? makerFor(author);
  const params     = paramsOf(shortName);
  const labels     = tagLabels(model.tags);

  // Stable quant based on hardware — shown immediately and stays consistent
  const estimatedQuant = globalFittedQuant(sysInfo);

  // Recommended file — recomputed when detail or sysInfo change
  const recommended = useMemo(
    () => (detail ? pickFittedFile(detail.gguf_files, sysInfo) : null),
    [detail, sysInfo],
  );
  const recSize   = recommended?.size ?? null;
  const recCompat = recSize ? compatLevel(recSize, sysInfo) : null;

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

  const header = (
    <div className="flex items-start gap-3">
      <MakerTile maker={maker} fallback={author || shortName} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-semibold text-text-primary" title={model.id}>{shortName}</h3>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
          {author && <span className="truncate">{author}</span>}
          <span className="inline-flex items-center gap-1"><Download size={12} />{fmtNum(model.downloads)}</span>
          <span className="inline-flex items-center gap-1"><Heart size={12} />{fmtNum(model.likes)}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => onExpand(model.id)}
        aria-expanded={expanded}
        aria-busy={opening}
        aria-label={expanded ? 'Hide variants' : 'Show variants'}
        title={opening ? 'Loading the files…' : expanded ? 'Hide variants' : 'Show variants'}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-primary"
      >
        {opening ? (
          <Loader2 size={16} className="animate-spin text-brand" />
        ) : (
          <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={FAST} className="inline-flex">
            <ChevronDown size={16} />
          </motion.span>
        )}
      </button>
    </div>
  );

  const action = isThisDownloading ? (
    <div className="flex min-w-[120px] items-center gap-2 rounded-xl border border-border-subtle bg-bg-elevated px-3 py-2 text-xs text-text-muted">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-hover">
        <div className="h-full bg-brand transition-all duration-(--motion-slow)" style={{ width: `${dlProgress}%` }} />
      </div>
      <span className="tabular-nums">{dlProgress.toFixed(0)}%</span>
    </div>
  ) : (
    <button
      type="button"
      onClick={(e) => void handleDownloadPill(e)}
      disabled={dlActive !== null && !isThisDownloading}
      title={`Downloads the ${recommended ? recommended.rfilename : `${estimatedQuant} file`}, picked for this machine`}
      className={BTN_PRIMARY}
    >
      <Download size={14} /> Install
    </button>
  );

  // The card never changes size or place when it opens. It used to span the
  // whole row and every card animated to its new spot: the dense grid moved
  // the next cards up into the gap, each piece flew on its own, and the text
  // stretched while the box scaled (seen in the real app, 21 Oct). The
  // details open as their own row under this one (HfVariantsRow).
  return (
    <article
      className={cn(
        CARD,
        'flex flex-col gap-3 p-4 transition-shadow hover:shadow-md',
        expanded && 'shadow-md ring-1 ring-brand/40',
      )}
    >
      {header}

      <div className="flex flex-wrap gap-1.5">
        <Chip accent>GGUF</Chip>
        {params && <Chip>{params}</Chip>}
        {labels.map((l) => <Chip key={l}>{l}</Chip>)}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-1">
        <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', recCompat ? COMPAT[recCompat].cls : 'text-text-muted')}>
          <Monitor size={14} className="shrink-0" />
          <span className="truncate">
            {recSize && recCompat
              ? `${sizeGb(recSize)} · ${COMPAT[recCompat].label}`
              : `${estimatedQuant} picked for your ${sysInfo && sysInfo.vram_total_mb > 0 ? 'GPU' : 'RAM'}`}
          </span>
        </span>
        {action}
      </div>

      {/* Download progress bar (full-width strip) */}
      {isThisDownloading && (
        <div className="-mx-4 -mb-4 h-0.5 bg-bg-elevated">
          <div className="h-full bg-brand transition-all duration-(--motion-slow)" style={{ width: `${dlProgress}%` }} />
        </div>
      )}
    </article>
  );
}

/** An opened card: every file in the repo, the best one for this machine
 *  first. A full-width grid row under the card's own row, so the cards stay
 *  where they are and only what is below slides down. `mb-4` stands in for
 *  the grid's row gap (BrowseTab drops it): a gap would appear at full size
 *  the moment this row mounts, a margin inside the animated height grows
 *  with it. */
export function HfVariantsRow({ model, detail }: { model: HfModelSummary; detail: HfModelDetail | null }) {
  const shortName = model.id.split('/').pop() ?? model.id;
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={BASE}
      className="col-span-full overflow-hidden"
    >
      <div className={cn(CARD, 'mb-4 grid gap-6 p-4 ring-1 ring-brand/40 lg:grid-cols-[240px_minmax(0,1fr)]')}>
        <div className="space-y-4">
          <h4 className="truncate text-base font-semibold text-text-primary" title={model.id}>{shortName}</h4>
          <dl className="grid grid-cols-3 gap-2 lg:grid-cols-1">
            <Stat label="Downloads" value={fmtNum(model.downloads)} />
            <Stat label="Likes" value={fmtNum(model.likes)} />
            <Stat label="Updated" value={fmtDate(model.last_modified)} />
          </dl>
          {model.tags.length > 0 && (
            <div>
              <p className="mb-1.5 text-micro uppercase tracking-wider text-text-muted">Tags</p>
              <div className="flex flex-wrap gap-1">
                {model.tags.slice(0, 10).map((t) => <Chip key={t}>{t}</Chip>)}
              </div>
            </div>
          )}
        </div>
        <div className="min-w-0">
          {!detail ? (
            <div className="flex justify-center py-6">
              <StreamingIndicator />
            </div>
          ) : (
            <HfDetailPanel repoId={model.id} detail={detail} loading={false} />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-elevated/60 px-3 py-2">
      <dt className="text-micro uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-text-primary">{value}</dd>
    </div>
  );
}
