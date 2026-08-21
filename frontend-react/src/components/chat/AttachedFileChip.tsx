import { X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

interface Props {
  file: AttachedFile;
  onRemove: () => void;
}

export function AttachedFileChip({ file, onRemove }: Props) {
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
        <X size={10} />
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
