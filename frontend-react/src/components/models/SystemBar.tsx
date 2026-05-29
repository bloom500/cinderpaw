import { useSystemInfo } from '@/stores/systemInfo';

export function SystemBar() {
  const info = useSystemInfo((s) => s.info);
  if (!info) return null;

  const vram =
    info.vram_total_mb > 0
      ? `${Math.round(info.vram_total_mb / 1024)} GB VRAM`
      : 'Integrated GPU';
  const ram = `${Math.round(info.ram_total_mb / 1024)} GB RAM`;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-bg-surface border-b border-border-subtle text-sm text-text-secondary shrink-0">
      <span className="font-medium">{info.gpu_name}</span>
      <span className="text-border-default">·</span>
      <span>{vram}</span>
      <span className="text-border-default">·</span>
      <span>{ram}</span>
      <span className="text-border-default">·</span>
      {info.supports_vulkan ? (
        <span className="text-success">Vulkan ✓</span>
      ) : (
        <span className="text-text-muted">Vulkan unavailable</span>
      )}
    </div>
  );
}
