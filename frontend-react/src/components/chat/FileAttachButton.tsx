import { Paperclip } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AttachedFile } from './AttachedFileChip';
import { attachmentFromPath } from '@/lib/attachments';

interface Props {
  onFilesSelected: (files: AttachedFile[]) => void;
}

export function FileAttachButton({ onFilesSelected }: Props) {
  const handleClick = async () => {
    const result = await open({ multiple: true });
    if (!result) return;

    const paths = Array.isArray(result) ? result : [result];
    const files: AttachedFile[] = await Promise.all(paths.map(attachmentFromPath));
    onFilesSelected(files);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void handleClick()}
          className="p-1.5 rounded text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          aria-label="Attach file"
        >
          <Paperclip size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent>Attach file</TooltipContent>
    </Tooltip>
  );
}
