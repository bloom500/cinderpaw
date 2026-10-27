import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * Image thumbnail with click-to-zoom. First click expands the image into a
 * fullscreen lightbox (smooth fade + scale), second click (anywhere) shrinks it
 * back. Escape closes too. Used for attached images and for the pictures a
 * tool brought back (a screenshot), so both open the same way.
 */
export function ZoomableImage({ src, alt, thumbClassName, className }: {
  src: string;
  alt: string;
  thumbClassName?: string;
  /** The thumbnail's button, e.g. `w-full` for a tile that fills its cell. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Two-phase mount so the CSS transition actually plays: render the overlay
  // in its "from" state first, then flip to "to" on the next frame.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setShown(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Unmount the overlay only after the shrink transition finishes.
  const onTransitionEnd = () => {
    if (!shown) setOpen(false);
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
          src={src}
          alt={alt}
          loading="lazy"
          className={cn(
            'rounded-lg border border-border-subtle object-contain transition-transform duration-200 hover:scale-[1.02]',
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
          onClick={() => setShown(false)}
          className={cn(
            'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs cursor-zoom-out',
            'transition-opacity duration-300 ease-out',
            shown ? 'opacity-100' : 'opacity-0',
          )}
        >
          <img
            src={src}
            alt={alt}
            onTransitionEnd={onTransitionEnd}
            className={cn(
              'max-h-[90vh] max-w-[92vw] rounded-xl object-contain shadow-2xl',
              'transition-transform duration-300 ease-out',
              shown ? 'scale-100' : 'scale-75',
            )}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
