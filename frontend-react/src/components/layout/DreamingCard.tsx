import { useDream, type DreamStage } from '@/stores/dream';
import { useUI } from '@/stores/ui';
import { CinderpawMascot } from '@/components/chat/mascot/CinderpawMascot';
import logoUrl from '@/assets/logo.svg';

/**
 * The stages the sidecar emits, in order (the same five the Dreams panel walks).
 * `dream` and `mutate` are reserved there, so they read as the middle of the cycle.
 */
const STAGES: DreamStage[] = ['wake', 'observe', 'evaluate', 'remember', 'sleep'];

const WORDS: Record<DreamStage, string> = {
  wake: 'Waking up',
  observe: "Looking over today's work",
  dream: 'Trying new settings',
  mutate: 'Trying new settings',
  evaluate: 'Testing what it tried',
  remember: 'Keeping what worked',
  sleep: 'Settling back down',
};

/** How far through the cycle a stage is, 0 to 1, from the stages that fire. */
export function dreamProgress(stage: DreamStage | null): number {
  if (!stage) return 0;
  const i = STAGES.indexOf(stage === 'dream' || stage === 'mutate' ? 'observe' : stage);
  return (i + 1) / STAGES.length;
}

/**
 * The Dreaming card (spec 7.2): at the bottom of the sidebar, only while the
 * dream cycle runs. The sleeping mascot, "Dreaming", what the current stage is
 * doing, and a thin bar that moves with the stages the sidecar reports.
 */
export function DreamingCard() {
  const dreaming = useDream((s) => s.dreaming);
  const stage = useDream((s) => s.stage);
  const mascot = useUI((s) => s.mascotEnabled);
  if (!dreaming) return null;
  const pct = Math.round(dreamProgress(stage) * 100);
  return (
    <div role="status" aria-label="Dreaming" className="mx-2.5 mb-2.5 mt-2 flex shrink-0 items-center gap-2.5 rounded-2xl border border-border-default bg-bg-elevated py-2 pl-1 pr-3">
      {mascot ? (
        <span aria-hidden className="relative -my-1 h-14 w-14 shrink-0 overflow-hidden">
          <span className="absolute left-0 top-0 origin-top-left scale-[0.4375]"><CinderpawMascot state="sleep" /></span>
        </span>
      ) : (
        <img src={logoUrl} alt="" className="ml-2 h-8 w-8 shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-text-primary">Dreaming</span>
        <span className="truncate text-2xs text-text-muted">{stage ? WORDS[stage] : 'Improving itself while you are away'}</span>
        <span className="mt-1 h-1 rounded-full bg-bg-active" aria-hidden>
          <span className="block h-1 rounded-full bg-brand transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </span>
      </span>
    </div>
  );
}
