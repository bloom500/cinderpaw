import { Paperclip } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
interface Props {
  /** The picked paths, handed over at once: the composer shows them while they are read. */
  onPathsSelected: (paths: string[]) => void;
}

export function FileAttachButton({ onPathsSelected }: Props) {
  const handleClick = async () => {
    const result = await open({ multiple: true });
    if (!result) return;
    onPathsSelected(Array.isArray(result) ? result : [result]);
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
