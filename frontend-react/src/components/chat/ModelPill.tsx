import { ModelPickerPopover } from './ModelPickerPopover';
import { ControlsPopover } from './ControlsPopover';

export function ModelPill() {
  return (
    <div className="flex items-center h-8 rounded-full bg-zinc-800/60 border border-white/10 overflow-hidden shrink-0">
      <ModelPickerPopover />
      <div className="w-px h-4 bg-white/10 shrink-0" />
      <ControlsPopover />
    </div>
  );
}
