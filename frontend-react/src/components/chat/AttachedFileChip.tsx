import { useState } from 'react';
import { FileText, X } from 'lucide-react';
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

export function AttachedFileChip({ file, onRemove }: Props) {
  if (isPasted(file)) return <PastedTextCard file={file} onRemove={onRemove} />;
  const isImage = file.kind === 'image' && !!file.dataUrl;
  // Binary files are a normal, supported attachment (sent as a path
  // reference) — only a real extraction/read error gets the red treatment.
  const hasError = !isImage && file.content === null && file.kind !== 'binary';

  const chip = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
        hasError
          ? 'border-error/40 bg-error/10 text-error'
          : 'border-border-default bg-bg-elevated text-text-secondary',
      )}
    >
      {isImage && (
        <img
          src={file.dataUrl}
          alt={file.name}
          className="h-6 w-6 rounded object-cover border border-border-subtle"
        />
      )}
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
