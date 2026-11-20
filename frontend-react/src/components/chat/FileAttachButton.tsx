import { AttachFileIcon } from '@/components/ui/animated-icons/attach-file';
import { useIconHover } from '@/components/ui/animated-icons/useIconHover';
import { open } from '@tauri-apps/plugin-dialog';
interface Props {
  /** The picked paths, handed over at once: the composer shows them while they are read. */
  onPathsSelected: (paths: string[]) => void;
}

export function FileAttachButton({ onPathsSelected }: Props) {
  const icon = useIconHover();
  const handleClick = async () => {
    const result = await open({ multiple: true });
    if (!result) return;
    onPathsSelected(Array.isArray(result) ? result : [result]);
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className="group flex h-8 shrink-0 items-center rounded-full border border-border-default bg-bg-hover px-2 text-text-secondary transition-colors hover:bg-bg-active hover:text-text-primary"
      aria-label="Add files"
      {...icon.hover}
    >
      <AttachFileIcon ref={icon.ref} size={16} className="flex shrink-0" />
      {/* The name slides out of the button instead of a tooltip, as in the
          21st.dev prompt composer (MIT) Darius picked on 1 Nov. */}
      <span className="composer-slide-label text-sm">Add files</span>
    </button>
  );
}
