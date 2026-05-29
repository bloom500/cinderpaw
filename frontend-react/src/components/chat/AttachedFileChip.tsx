import { X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface AttachedFile {
  name: string;
  path: string;
  content: string | null;
  error?: string;
}

interface Props {
  file: AttachedFile;
  onRemove: () => void;
}

export function AttachedFileChip({ file, onRemove }: Props) {
  const hasError = file.content === null;

  const chip = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
        hasError
          ? 'border-rose-400/40 bg-rose-400/10 text-rose-400'
          : 'border-border-default bg-bg-elevated text-text-secondary',
      )}
    >
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
