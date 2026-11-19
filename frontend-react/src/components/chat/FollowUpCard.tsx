import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, X } from 'lucide-react';
import { useFollowUps } from '@/stores/followUps';
import { useCoworkTeam } from '@/stores/coworkTeam';
import { tauri } from '@/lib/tauri';
import { GooeyCard } from './GooeyCard';

/** Tell the engine what the person did with the card; it only counts it. */
function report(action: 'nudge_opened' | 'nudge_dismissed', cardId: string) {
  void tauri.raw.cinderpawCronOp(crypto.randomUUID(), action, { jobId: cardId }).catch(() => {});
}

export function FollowUpCard() {
  const { enabled, card, expiresAt, dismiss } = useFollowUps();
  const teammateId = card?.sessionId.startsWith('cowork:') ? card.sessionId.slice(7) : null;
  const teammateName = useCoworkTeam((s) => s.roster.find((agent) => agent.id === teammateId)?.name);
  const navigate = useNavigate();
  if (!enabled || !card || expiresAt <= Date.now()) return null;
  return (
    <section aria-label="Unfinished work" className="mx-auto w-full max-w-[764px] px-4 pb-2">
      <GooeyCard>
        <button type="button" aria-label="Dismiss follow-up" onClick={() => { report('nudge_dismissed', card.id); dismiss(); }} className="absolute right-2 top-2 rounded-full p-1 text-text-muted hover:text-text-primary"><X size={16} /></button>
        <p className="pr-5 text-sm font-semibold text-text-primary">{teammateName ? `${teammateName} has unfinished work` : 'You left something unfinished'}</p>
        <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{card.mission}</p>
        <div className="mt-2 flex items-center gap-3">
          <button type="button" className="flex items-center gap-1 text-xs font-medium text-brand" onClick={() => {
            report('nudge_opened', card.id);
            navigate(teammateId ? `/teammates/${encodeURIComponent(teammateId)}` : `/chat/${encodeURIComponent(card.sessionId)}`);
            dismiss();
          }}>Open conversation <ArrowUpRight size={14} aria-hidden /></button>
          <span className="text-2xs text-text-muted">Nothing resumes until you ask.</span>
        </div>
      </GooeyCard>
    </section>
  );
}
