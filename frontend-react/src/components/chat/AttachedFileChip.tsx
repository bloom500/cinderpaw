import { useState } from 'react';
import { FileText, Loader2, Play, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface AttachedFile {
  name: string;
  /** OS path for picked/dropped files; synthetic `clipboard://` for pastes. */
  path: string;
  /** Extracted text for text files; null for images and binary files. */
  content: string | null;
  /**
   * 'image' renders a thumbnail chip; 'binary' is a file with no extractable
   * text — still attached as a path reference for the model; default is text.
   */
  kind?: 'text' | 'image' | 'binary';
  /** data:<mime>;base64 payload for image attachments. */
  dataUrl?: string;
  /** Asset URL of a video (still a `binary` path for the model), for its first frame in the composer. */
  videoUrl?: string;
  /** Shown by name with a spinner while it is read; the message cannot be sent until it is. */
  loading?: boolean;
  error?: string;
}

/** A paste longer than this many characters or lines is attached, not typed in (spec 6). */
export const PASTE_MAX_CHARS = 1_200;
export const PASTE_MAX_LINES = 20;

export function isLongPaste(text: string): boolean {
  return text.length > PASTE_MAX_CHARS || text.split('\n').length > PASTE_MAX_LINES;
}

/** A long paste as an attachment: the whole text goes with the message. */
export function pastedText(text: string): AttachedFile {
  const lines = text.split('\n').length;
  return {
    name: `Pasted text, ${lines} line${lines === 1 ? '' : 's'}`,
    path: `clipboard://pasted-${crypto.randomUUID()}`,
    content: text,
    kind: 'text',
  };
}

const isPasted = (f: AttachedFile) => f.path.startsWith('clipboard://pasted-');

/** The card a long paste becomes: its first line, its size, and a click to read it all. */
function PastedTextCard({ file, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const first = (file.content ?? '').split('\n').find((l) => l.trim()) ?? '';
  return (
    <>
      <span className="inline-flex max-w-64 items-center gap-2 rounded-xl border border-border-default bg-bg-elevated py-1.5 pl-2 pr-1.5">
        <button type="button" onClick={() => setOpen(true)} className="flex min-w-0 items-center gap-2 text-left" aria-label={`Open ${file.name}`}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-active text-brand"><FileText size={14} /></span>
          <span className="min-w-0">
            <span className="block truncate text-2xs font-medium text-text-primary">{first}</span>
            <span className="block text-micro text-text-disabled">{file.name}</span>
          </span>
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`}
          className="shrink-0 rounded p-0.5 text-text-muted hover:text-text-primary">
          <X size={12} />
        </button>
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>{file.name}</DialogTitle>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-bg-surface p-3 font-sans text-sm text-text-primary thin-scrollbar">
            {file.content}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface Props {
  file: AttachedFile;
  onRemove: () => void;
}

/**
 * A photo or video shows itself, not its name: a thumbnail like the one the
 * person picked. A video shows its first frame; one the webview cannot decode
 * falls back to the name chip.
 */
function MediaTile({ file, onRemove }: Props) {
  const [broken, setBroken] = useState(false);
  if (broken) return <NameChip file={file} onRemove={onRemove} />;
  return (
    <span className="relative inline-block h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border-default bg-bg-elevated" title={file.name}>
      {file.videoUrl ? (
        <>
          {/* #t=0.1: a frame to show; muted + metadata: nothing plays or downloads whole. */}
          <video src={`${file.videoUrl}#t=0.1`} muted playsInline preload="metadata" aria-label={file.name}
            onError={() => setBroken(true)} className="h-full w-full object-cover" />
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white"><Play size={12} fill="currentColor" /></span>
          </span>
        </>
      ) : (
        <img src={file.dataUrl} alt={file.name} className="h-full w-full object-cover" />
      )}
      <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`}
        className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80">
        <X size={12} />
      </button>
    </span>
  );
}

export function AttachedFileChip({ file, onRemove }: Props) {
  if (isPasted(file)) return <PastedTextCard file={file} onRemove={onRemove} />;
  if ((file.kind === 'image' && file.dataUrl) || file.videoUrl) return <MediaTile file={file} onRemove={onRemove} />;
  return <NameChip file={file} onRemove={onRemove} />;
}

function NameChip({ file, onRemove }: Props) {
  // Binary files are a normal, supported attachment (sent as a path
  // reference) — only a real extraction/read error gets the red treatment.
  const hasError = !file.loading && file.content === null && file.kind !== 'binary';

  const chip = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
        hasError
          ? 'border-error/40 bg-error/10 text-error'
          : 'border-border-default bg-bg-elevated text-text-secondary',
      )}
    >
      {file.loading && <Loader2 size={12} className="shrink-0 animate-spin text-text-muted" aria-label="Reading" />}
      <span className="max-w-[120px] truncate">{file.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded hover:text-text-primary"
        aria-label={`Remove ${file.name}`}
      >
        <X size={12} />
      </button>
    </span>
  );

  if (hasError) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent>{file.error ?? 'Unsupported format'}</TooltipContent>
      </Tooltip>
    );
  }

  return chip;
}
