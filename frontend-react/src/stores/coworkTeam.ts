import { create } from 'zustand';
import { tauri, type CoworkTeammate } from '@/lib/tauri';

/**
 * The teammate roster, for the Settings list.
 *
 * Before this the roster was visible nowhere: a teammate could be created from
 * chat, and from then on the only trace of it was the panel in a chat where it
 * had already worked. Nobody could see who existed, what they may touch, or
 * remove one.
 *
 * Requests are fire-and-forget; the answer is a `cowork_team_result` event,
 * which the stream handler hands to `receive`.
 */
interface CoworkTeamStore {
  roster: CoworkTeammate[];
  /** False until the first answer arrives, so "no teammates" is never a guess. */
  loaded: boolean;
  /** Set while a request is out, cleared by its answer. */
  busy: boolean;
  /** A line for the person when the last action failed. */
  error: string | null;
  /** Who the last remove deleted, for the confirmation line. */
  removed: string | null;
  refresh: () => Promise<void>;
  remove: (agentId: string) => Promise<void>;
  receive: (e: { roster: CoworkTeammate[]; removed?: string; error?: string }) => void;
}

export const useCoworkTeam = create<CoworkTeamStore>()((set) => {
  const send = async (action: 'list' | 'remove', agentId?: string) => {
    set({ busy: true, error: null, removed: null });
    try {
      await tauri.cinderpawAgent.coworkTeam(action, agentId);
    } catch (err) {
      // The engine is not running or refused the request: say so, rather than
      // leave a list that silently never loads.
      set({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  return {
    roster: [],
    loaded: false,
    busy: false,
    error: null,
    removed: null,
    refresh: () => send('list'),
    remove: (agentId) => send('remove', agentId),
    receive: (e) =>
      set({ roster: e.roster, loaded: true, busy: false, error: e.error ?? null, removed: e.removed ?? null }),
  };
});
