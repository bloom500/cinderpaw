import { useRef } from 'react';

export type IconHandle = { startAnimation: () => void; stopAnimation: () => void };

/**
 * Lets a whole button play its animated icon (this folder) on hover or
 * keyboard focus, not only when the pointer is over the small glyph.
 * Spread `hover` on the button and pass `ref` to the icon. Leaving eases the
 * icon back; it never snaps.
 */
export function useIconHover<T extends IconHandle = IconHandle>() {
  const ref = useRef<T>(null);
  const play = () => ref.current?.startAnimation();
  const settle = () => ref.current?.stopAnimation();
  return { ref, hover: { onPointerEnter: play, onPointerLeave: settle, onFocus: play, onBlur: settle } };
}
