import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface FollowUp { id: string; sessionId: string; mission: string }
interface FollowUps {
  enabled: boolean;
  card: FollowUp | null;
  expiresAt: number;
  dismissed: string[];
  receive: (card: unknown) => void;
  dismiss: () => void;
  setEnabled: (enabled: boolean) => void;
  clearSession: (sessionId: string) => void;
}
const WEEK = 7 * 86_400_000;
function validCard(value: unknown): value is FollowUp {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<FollowUp>;
  return [c.id, c.sessionId, c.mission].every((v) => typeof v === 'string' && !!v.trim());
}

/** Suggestions survive a window hide/restart; pressing Open never sends work. */
export const useFollowUps = create<FollowUps>()(persist((set, get) => ({
  enabled: true,
  card: null,
  expiresAt: 0,
  dismissed: [],
  receive: (value) => {
    if (!get().enabled || !validCard(value)) return;
    if (get().dismissed.includes(value.id)) return;
    set({ card: { id: value.id.slice(0, 200), sessionId: value.sessionId.slice(0, 200), mission: value.mission.slice(0, 1000) }, expiresAt: Date.now() + WEEK });
  },
  dismiss: () => set((s) => ({ card: null, dismissed: s.card ? [...s.dismissed, s.card.id].slice(-512) : s.dismissed })),
  setEnabled: (enabled) => set({ enabled, ...(!enabled ? { card: null } : {}) }),
  clearSession: (sessionId) => { if (get().card?.sessionId === sessionId) get().dismiss(); },
}), { name: 'cinderpaw-followups-v1', merge: (persisted, current) => {
  const p = persisted && typeof persisted === 'object' ? persisted as Partial<FollowUps> : {};
  const enabled = p.enabled !== false;
  const expiresAt = typeof p.expiresAt === 'number' && p.expiresAt <= Date.now() + WEEK ? p.expiresAt : 0;
  return { ...current, enabled, expiresAt,
    card: enabled && expiresAt > Date.now() && validCard(p.card) ? p.card : null,
    dismissed: Array.isArray(p.dismissed) ? p.dismissed.filter((v): v is string => typeof v === 'string').slice(-512) : [],
  };
} }));
