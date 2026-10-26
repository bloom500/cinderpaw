import { useEffect } from 'react';
import { tauri } from '@/lib/tauri';
import { useChat } from '@/stores/chat';

// ponytail: fixed 3 minutes; tie it to idle time if people say it lands mid-task.
export const MEMORY_MODEL_DELAY_MS = 3 * 60_000;

/**
 * The memory model (~630 MB) waits for the first useful moment: the first
 * finished reply, or a few minutes in for someone who only talks by voice.
 * Starting it at launch made a stranger's first minute a big download they
 * never asked for (audit, 20 Oct). Nothing is lost meanwhile: recall uses
 * keyword search, and memories saved before the model arrives are embedded on
 * a later start. Idempotent: a no-op when the model is already on disk.
 */
export function useDeferredMemoryModel(): void {
  useEffect(() => {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void tauri.raw.downloadEmbeddingModel().catch(() => {});
    };
    const timer = setTimeout(start, MEMORY_MODEL_DELAY_MS);
    const unsubscribe = useChat.subscribe((s) => { if (s.streamStatus === 'done') start(); });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, []);
}
