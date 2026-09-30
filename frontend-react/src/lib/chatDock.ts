import { useSyncExternalStore } from 'react';

/**
 * The composer dock's measured height, published by ChatPage for the things
 * that float above the composer or must clear it (the transcript's bottom
 * padding, "Jump to bottom").
 *
 * It was a CSS variable, `--chat-dock-h`, set on the chat's container. A
 * custom property inherits, so every change restyled the whole transcript
 * under that container, and the dock changes height on every frame while the
 * composer's second row slides open or shut: at the start and end of every
 * reply and on every focus, 350 to 600 elements restyled per frame. Read from
 * here, a change touches the two elements that use it and nothing else.
 */
let height: number | null = null;
const listeners = new Set<() => void>();

export function setChatDockHeight(px: number): void {
  if (px === height) return;
  height = px;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Null until ChatPage has measured the dock once. */
export function useChatDockHeight(): number | null {
  return useSyncExternalStore(subscribe, () => height);
}
