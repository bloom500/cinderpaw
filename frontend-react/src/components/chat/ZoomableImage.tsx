import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * Image thumbnail with click-to-zoom. Click grows the picture out of the
 * thumbnail into a lightbox; a click on the dark around it (or Escape) shrinks
 * it back INTO the thumbnail. Used for attached images and for the pictures a
 * tool brought back (a screenshot), so both open the same way.
 *
 * It used to grow from 75% in the middle of the screen and shrink back there,
 * while the thumbnail sat elsewhere in the chat: measured smooth frame by frame,
 * it still read as a jump on close, because the picture vanished in one place
 * and the thumbnail was left in another (Darius, 29 Oct 2026). Now it is one
 * picture moving, like Photos on an iPhone.
 *
 * Inside, like Photos too (his ask, 30 Oct: four clicks to see a detail and get
 * out, and no way to look around a screenshot): a click on the picture zooms in
 * where it landed, the wheel zooms, a drag moves a zoomed picture, and one click
 * on the dark closes it from any zoom.
 */
const ZOOM_STEP = 2.5;
const ZOOM_MAX = 6;
/** Pixels a press may wander and still count as a click, not a drag. */
const DRAG_SLOP = 4;

export function ZoomableImage({ src, alt, thumbClassName, className }: {
  src: string;
  alt: string;
  thumbClassName?: string;
  /** The thumbnail's button, e.g. `w-full` for a tile that fills its cell. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const thumb = useRef<HTMLImageElement>(null);
  const big = useRef<HTMLImageElement>(null);
  const lens = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  /** The transform that lays the big picture exactly over the thumbnail. */
  const overThumb = () => {
    const a = thumb.current?.getBoundingClientRect();
    const b = big.current;
    if (!a || !b) return 'none';
    // The big picture's resting box, measured without any transform on it.
    const prev = b.style.transform;
    b.style.transform = 'none';
    const r = b.getBoundingClientRect();
    b.style.transform = prev;
    if (!r.width || !r.height) return 'none';
    return `translate(${a.left - r.left}px, ${a.top - r.top}px) scale(${a.width / r.width}, ${a.height / r.height})`;
  };

  // Open: start ON the thumbnail with no transition, then let it travel.
  useLayoutEffect(() => {
    if (!open || !big.current) return;
    big.current.style.transition = 'none';
    big.current.style.transform = overThumb();
    const raf = requestAnimationFrame(() => {
      if (!big.current) return;
      big.current.style.transition = '';
      big.current.style.transform = 'none';
      setShown(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const close = () => {
    // Out of the zoom at once, so the flight back starts from the whole picture.
    // No transition here: a running one would still report the zoomed box to overThumb.
    if (lens.current) { lens.current.style.transition = 'none'; lens.current.style.transform = 'none'; }
    setView({ zoom: 1, x: 0, y: 0 });
    if (big.current) big.current.style.transform = overThumb();
    setShown(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Unmount only once the picture has landed back on the thumbnail.
  const onTransitionEnd = (e: React.TransitionEvent) => {
    if (e.target === big.current && !shown && e.propertyName === 'transform') setOpen(false);
  };

  /** Zoom to `zoom`, keeping the point under (cx, cy) where it is on screen. */
  const zoomAt = (zoom: number, cx: number, cy: number) => {
    const box = big.current?.getBoundingClientRect();
    setView((v) => {
      const z = Math.min(ZOOM_MAX, Math.max(1, zoom));
      if (z === 1 || !box) return { zoom: 1, x: 0, y: 0 };
      // The lens scales around the picture's centre; box is the picture as drawn now.
      const ox = cx - (box.left + box.width / 2);
      const oy = cy - (box.top + box.height / 2);
      const k = z / v.zoom;
      return { zoom: z, x: v.x - ox * (k - 1), y: v.y - oy * (k - 1) };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    press.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || view.zoom === 1) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    p.moved = true;
    setDragging(true);
    setView((v) => ({ ...v, x: p.vx + dx, y: p.vy + dy }));
  };
  const onPointerUp = () => { setDragging(false); };
  // A click on the picture zooms in where it landed, or back out; a drag is not a click.
  const onPictureClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (press.current?.moved) return;
    if (view.zoom > 1) setView({ zoom: 1, x: 0, y: 0 });
    else zoomAt(ZOOM_STEP, e.clientX, e.clientY);
  };
  const onWheel = (e: React.WheelEvent) => {
    zoomAt(view.zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX, e.clientY);
  };

  return (
    <>
      {/* A real button, not a click handler on an <img>: the thumbnail was not
          focusable and carried no role, so opening an attachment full-size was
          mouse-only. Escape already closed the lightbox; nothing could open it. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${alt || 'image'} full size`}
        className={cn('block cursor-zoom-in rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand', className)}
      >
        <img
          ref={thumb}
          src={src}
          alt={alt}
          loading="lazy"
          className={cn(
            'rounded-lg border border-border-subtle object-contain',
            // The picture is in flight: one picture, not two.
            open && 'invisible',
            thumbClassName ?? 'max-h-52 max-w-full',
          )}
        />
      </button>
      {/* In a portal: the message row clips and contains what it draws
          (MessageList), so a fixed overlay inside it would fill only the row. */}
      {open && createPortal(
        <div
          role="button"
          aria-label="Close image preview"
          onClick={close}
          onWheel={onWheel}
          className={cn(
            'fixed inset-0 z-50 flex items-center justify-center overflow-hidden',
            'transition-[background-color] duration-(--motion-slow) ease-out',
            shown ? 'bg-black/70' : 'bg-black/0',
          )}
        >
          {/* The lens zooms and moves; the picture inside it does the flight,
              so the two transforms never fight. */}
          <div
            ref={lens}
            data-testid="image-lens"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={onPictureClick}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
            className={cn(
              'touch-none select-none',
              !dragging && 'transition-transform duration-(--motion-base) ease-out',
              view.zoom > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
            )}
          >
            <img
              ref={big}
              src={src}
              alt={alt}
              draggable={false}
              onTransitionEnd={onTransitionEnd}
              style={{ transformOrigin: '0 0' }}
              className={cn(
                'max-h-[90vh] max-w-[92vw] rounded-xl object-contain',
                'transition-transform duration-(--motion-slow) ease-out',
                shown && 'shadow-2xl',
              )}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
