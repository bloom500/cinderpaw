import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useSettings } from '@/stores/settings';
import { useSystemInfo } from '@/stores/systemInfo';

export function HardwareTab() {
  const settings = useSettings((s) => s.settings);
  const update   = useSettings((s) => s.updateSettings);
  const save     = useSettings((s) => s.save);
  const saved    = useSettings((s) => s.saved);
  const saving   = useSettings((s) => s.saving);

  const info  = useSystemInfo((s) => s.info);
  const fetch = useSystemInfo((s) => s.fetch);
  useEffect(() => { void fetch(); }, [fetch]);

  const gpuOn = (settings?.default_gpu_layers ?? 100) !== 0;
  const gpuPct = Math.min(100, Math.max(0, settings?.default_gpu_layers ?? 100));

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Hardware</h2>

      {/* GPU toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">GPU acceleration</p>
          <p className="text-xs text-text-muted mt-0.5">
            {info
              ? `${info.gpu_name} · ${info.supports_vulkan ? 'Vulkan available' : 'Vulkan unavailable'}`
              : 'Detecting…'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={gpuOn}
          onClick={() => update({ default_gpu_layers: gpuOn ? 0 : 100 })}
          className={cn(
            'w-10 h-6 rounded-full transition-colors relative shrink-0',
            gpuOn ? 'bg-blue-500' : 'bg-bg-hover',
          )}
        >
          <span
            className={cn(
              'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
              gpuOn ? 'translate-x-5' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {/* GPU usage slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-text-primary">GPU usage</p>
            <p className="text-xs text-text-muted mt-0.5">0% = CPU only · 100% = Full GPU offload</p>
          </div>
          <span className="text-sm text-text-secondary tabular-nums">{gpuPct}%</span>
        </div>
        <input
          type="range" min={0} max={100} step={1}
          value={gpuPct}
          onChange={(e) => update({ default_gpu_layers: Number(e.target.value) })}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-xs text-text-muted">
          <span>CPU</span>
          <span>GPU</span>
        </div>
      </div>

      {/* HW info card */}
      {info && (
        <div className="rounded-lg border border-border-subtle p-4 space-y-2 bg-bg-surface">
          <div className="flex justify-between text-sm">
            <span className="text-text-muted">GPU</span>
            <span className="text-text-primary">
              {info.vram_total_mb > 0
                ? `${info.gpu_name} · ${Math.round(info.vram_total_mb / 1024)} GB VRAM`
                : info.gpu_name}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-muted">RAM</span>
            <span className="text-text-primary">{Math.round(info.ram_total_mb / 1024)} GB</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-muted">CPU</span>
            <span className="text-text-primary">{info.cpu}</span>
          </div>
        </div>
      )}

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !settings}
          className="px-4 py-2 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-text-muted">✓ Saved</span>}
      </div>
    </div>
  );
}
