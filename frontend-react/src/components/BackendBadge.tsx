/**
 * Where the local model is actually running.
 *
 * The runtime already knew this and only whispered it into a log line, so a user
 * whose GPU silently fell back to CPU just experienced "Cinderpaw is slow" and had
 * no way to connect that to their card. This badge says it out loud, and — when
 * the news is bad — says WHY and what to do about it.
 *
 * Nothing renders for a cloud model: there is no local backend to report.
 */

import { Cpu, Zap, AlertTriangle } from 'lucide-react';
import { useModel } from '@/stores/model';
import { cn } from '@/lib/utils';

type Tone = 'gpu' | 'hybrid' | 'cpu-fallback' | 'cpu';

function classify(backend: string, onGpu: number, total: number): Tone {
  if (backend.startsWith('GPU')) return onGpu > 0 && total > 0 && onGpu < total ? 'hybrid' : 'gpu';
  // A GPU-capable build that ended up on the CPU is the case worth flagging:
  // the user has a card, it just isn't being used.
  if (backend.includes('GPU build')) return 'cpu-fallback';
  return 'cpu';
}

export function BackendBadge({ className }: { className?: string }) {
  const loaded = useModel((s) => s.loaded);
  if (!loaded?.backend) return null;

  const { backend, gpu_layers: onGpu, gpu_layers_total: total } = loaded;
  const tone = classify(backend, onGpu, total);

  const label =
    tone === 'gpu'          ? 'GPU'
    : tone === 'hybrid'     ? `GPU ${onGpu}/${total}`
    : tone === 'cpu-fallback' ? 'CPU · GPU unused'
    : 'CPU';

  const title =
    tone === 'gpu'          ? `Running on the GPU: ${backend}.`
    : tone === 'hybrid'     ? `${onGpu} of ${total} layers are on the GPU; the rest run on the CPU because they did not fit in VRAM. A smaller model or a shorter context window puts more on the card.`
    : tone === 'cpu-fallback' ? 'This build can use your GPU, but the model did not fit in VRAM (or the driver refused the allocation), so it is running entirely on the CPU, which is much slower. Try a smaller model or a shorter context window in Settings → Hardware.'
    : 'Running on the CPU.';

  const Icon = tone === 'gpu' ? Zap : tone === 'cpu-fallback' ? AlertTriangle : Cpu;

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro font-medium leading-none border',
        tone === 'gpu' && 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10',
        tone === 'hybrid' && 'border-sky-500/30 text-sky-400 bg-sky-500/10',
        tone === 'cpu-fallback' && 'border-amber-500/30 text-amber-400 bg-amber-500/10',
        tone === 'cpu' && 'border-border-default text-text-muted bg-bg-hover',
        className,
      )}
    >
      <Icon size={10} strokeWidth={2} />
      {label}
    </span>
  );
}
