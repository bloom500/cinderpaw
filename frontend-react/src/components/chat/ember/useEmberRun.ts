import { useEffect, useState } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { emberAvailability } from './emberAvailability';

/** How long a task must have been running before the campfire is offered. */
export const OFFER_AFTER_MS = 15_000;

export interface EmberRound {
  /** When the panel first opened: only tool calls from then on throw sparks. */
  since: number;
  /** Set once the task finishes; `ok` is false for an error or a stop. */
  ended: { ok: boolean } | null;
}

export interface EmberRun {
  /** Show the campfire icon. */
  offered: boolean;
  /** The panel is on screen. */
  open: boolean;
  /** The game is loaded (visible, or paused behind a closed panel). */
  round: EmberRound | null;
  openPanel: () => void;
  closePanel: () => void;
}

export function useEmberRun(): EmberRun {
  const status = useChat((s) => s.streamStatus);
  const sessionId = useChat((s) => s.sessionId);
  const enabled = useUI((s) => s.emberGameEnabled && s.mascotEnabled);
  const [available, setAvailable] = useState(false);
  const [runStart, setRunStart] = useState<number | null>(null);
  const [due, setDue] = useState(false);
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState<EmberRound | null>(null);

  useEffect(() => {
    let live = true;
    void emberAvailability().then((a) => { if (live) setAvailable(a.ok); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (status === 'streaming') {
      setRunStart((t) => t ?? Date.now());
      return;
    }
    setRunStart(null);
    setRound((r) => (r && !r.ended ? { ...r, ended: { ok: status === 'done' } } : r));
  }, [status]);

  useEffect(() => {
    setDue(false);
    if (runStart === null) return;
    const id = setTimeout(() => setDue(true), Math.max(0, runStart + OFFER_AFTER_MS - Date.now()));
    return () => clearTimeout(id);
  }, [runStart]);

  // Another chat is another task: its round is not this one.
  useEffect(() => {
    setOpen(false);
    setRound(null);
  }, [sessionId]);

  return {
    offered: due && enabled && available && !open,
    open,
    round,
    openPanel: () => {
      setRound((r) => r ?? { since: Date.now(), ended: null });
      setOpen(true);
    },
    closePanel: () => {
      setOpen(false);
      setRound((r) => (r?.ended ? null : r));
    },
  };
}
