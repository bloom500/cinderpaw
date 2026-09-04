import { ModelPickerPopover } from './ModelPickerPopover';
import { ControlsPopover } from './ControlsPopover';
import { useModel } from '@/stores/model';

export function ModelPill() {
  const isLoading = useModel((s) => s.isLoading);
  const progress  = useModel((s) => s.loadProgress);

  return (
    // A ghost chip inside the composer, not a bordered button floating in the
    // page corner. The model is context for the field you are typing in, so it
    // belongs on the field — and the name alone is the label, because "Add a
    // model" was an instruction on a screen where nobody had to obey it.
    <div className="relative flex items-center h-8 rounded-full hover:bg-bg-hover transition-colors overflow-hidden shrink-0">
      <ModelPickerPopover />
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
