import type { ReactNode } from 'react';
import { Cpu, Gpu, MemoryStick, Zap } from 'lucide-react';
import { useSystemInfo } from '@/stores/systemInfo';
import { CARD } from './ui';
import { cn } from '@/lib/utils';

/** "AMD Ryzen 7 1800X Eight-Core Processor" reads as "Ryzen 7 1800X". */
function shortCpu(name: string): string {
  return name
    .replace(/\((?:R|TM)\)/gi, '')
    .replace(/\b(?:AMD|Intel|Core\(TM\))\b/gi, '')
    .replace(/\b[\w-]+-Core\b|\bProcessor\b|\bCPU\b|@.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

/** "AMD Radeon RX 580" reads as "RX 580"; unknown names pass through. */
function shortGpu(name: string): string {
  return name.replace(/^(?:AMD|NVIDIA|Intel\(R\)|Intel)\s+/i, '').replace(/^(?:Radeon|GeForce)\s+(?=RX|RTX|GTX)/i, '').trim() || name;
}

const gb = (mb: number) => `${Math.round(mb / 1024)} GB`;

function Cell({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-5 py-4">
      <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-bg-elevated text-text-secondary">{icon}</span>
      <div className="min-w-0">
        <p className="text-micro font-medium uppercase tracking-wider text-text-muted">{label}</p>
        <p className="truncate text-sm font-semibold text-text-primary" title={value}>{value}</p>
        <p className="truncate text-xs text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

/** The machine the local models run on, as four facts. */
export function SystemBar() {
  const info = useSystemInfo((s) => s.info);
  if (!info) return null;

  const hasVram = info.vram_total_mb > 0;
  return (
    <div className={cn(CARD, 'grid grid-cols-2 divide-border-subtle lg:grid-cols-4 lg:divide-x')}>
      <Cell icon={<Cpu size={20} />} label="CPU" value={shortCpu(info.cpu)} detail={`${info.cores} threads`} />
      <Cell
        icon={<Gpu size={20} />}
        label="GPU"
        value={shortGpu(info.gpu_name)}
        detail={hasVram ? `${gb(info.vram_total_mb)} VRAM` : 'Integrated graphics'}
      />
      <Cell
        icon={<MemoryStick size={20} />}
        label="Memory"
        value={gb(info.ram_total_mb)}
        detail={`${gb(Math.max(0, info.ram_total_mb - info.ram_used_mb))} free now`}
      />
      <Cell
        icon={<Zap size={20} />}
        label="Acceleration"
        value={info.supports_vulkan ? 'Vulkan' : 'CPU only'}
        detail={info.supports_vulkan ? 'Models can run on the GPU' : 'Vulkan is not available'}
      />
    </div>
  );
}
