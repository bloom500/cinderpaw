import { cn } from '@/lib/utils';

export function WaveformBars({
  peaks,
  progress,
  className,
}: {
  peaks: number[];
  progress: number;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-[2px] h-6', className)}>
      {peaks.map((p, i) => {
        const played = i / peaks.length < progress;
        return (
          <span
            key={i}
            data-bar
            data-played={played}
            className={cn(
              'w-[2px] rounded-full transition-colors',
              played ? 'bg-brand' : 'bg-text-muted/40',
            )}
            style={{ height: `${Math.max(10, p * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
