import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, X } from 'lucide-react';
import { useFollowUps } from '@/stores/followUps';
import { GooeyCard } from './GooeyCard';

export function FollowUpCard() {
  const { enabled, card, expiresAt, dismiss } = useFollowUps();
  const navigate = useNavigate();
  if (!enabled || !card || expiresAt <= Date.now()) return null;
  return (
    <section aria-label="Unfinished work" className="mx-auto w-full max-w-[764px] px-4 pb-2">
      <GooeyCard>
        <button type="button" aria-label="Dismiss follow-up" onClick={dismiss} className="absolute right-2 top-2 rounded-full p-1 text-text-muted hover:text-text-primary"><X size={16} /></button>
        <p className="pr-5 text-sm font-semibold text-text-primary">You left something unfinished</p>
        <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{card.mission}</p>
        <div className="mt-2 flex items-center gap-3">
          <button type="button" className="flex items-center gap-1 text-xs font-medium text-brand" onClick={() => {
            navigate(`/chat/${encodeURIComponent(card.sessionId)}`);
            dismiss();
          }}>Open conversation <ArrowUpRight size={14} aria-hidden /></button>
          <span className="text-2xs text-text-muted">Nothing resumes until you ask.</span>
        </div>
      </GooeyCard>
    </section>
  );
}
