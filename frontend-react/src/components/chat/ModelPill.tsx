import { ModelPickerPopover } from './ModelPickerPopover';
import { ControlsPopover } from './ControlsPopover';
import { useModel } from '@/stores/model';

export function ModelPill() {
  const isLoading = useModel((s) => s.isLoading);
  const progress  = useModel((s) => s.loadProgress);

  return (
    <div className="relative flex items-center h-9 rounded-full bg-bg-elevated border border-border-default overflow-hidden shrink-0 shadow-sm">
      <ModelPickerPopover />
      <div className="w-px h-4 bg-white/10 shrink-0" />
      <ControlsPopover />
      {/* Thin progress bar at the bottom of the pill while a local model is
          loading. The store's load() emits model-load-progress events which
          keep progress.percentage in sync; a missing event leaves the bar
          hidden (overflow-hidden + null guard). */}
      {isLoading && progress && (
        <div
          className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/10 pointer-events-none"
          role="progressbar"
          aria-valuenow={progress.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-brand transition-all duration-300"
            style={{ width: `${progress.percentage}%` }}
          />
        </div>
      )}
    </div>
  );
}
