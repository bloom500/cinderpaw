import { ModelPickerPopover } from './ModelPickerPopover';
import { ControlsPopover } from './ControlsPopover';

export function ModelPill() {
  return (
    <div className="flex items-center h-9 rounded-full bg-zinc-800/80 border border-white/15 overflow-hidden shrink-0 shadow-sm">
      <ModelPickerPopover />
      <div className="w-px h-4 bg-white/10 shrink-0" />
      <ControlsPopover />
    </div>
  );
}
