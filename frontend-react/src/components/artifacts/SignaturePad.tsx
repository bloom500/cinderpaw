import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Draw a signature with a mouse, a pen or a finger.
 *
 * The result is cropped to the ink and returned as a transparent PNG, so it
 * sits on the page's line instead of carrying a white rectangle with it. What
 * is drawn here stays in this window: it is not stored, and it reaches a file
 * only when the person places it and saves.
 *
 * This is a drawn signature, the thing Acrobat's "Fill & Sign" makes. It is not
 * a certificate-backed digital signature, and nothing on screen says otherwise.
 */
export function SignaturePad({
  open,
  onOpenChange,
  onUse,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUse: (png: string, aspect: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    if (!open) return;
    setEmpty(true);
  }, [open]);

  const ctx = () => {
    const c = canvasRef.current;
    const g = c?.getContext('2d');
    if (!c || !g) return null;
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#111827';
    return { c, g };
  };

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * e.currentTarget.width) / r.width,
      y: ((e.clientY - r.top) * e.currentTarget.height) / r.height,
    };
  };

  const clear = () => {
    const k = ctx();
    k?.g.clearRect(0, 0, k.c.width, k.c.height);
    setEmpty(true);
  };

  const use = () => {
    const k = ctx();
    if (!k) return;
    const crop = inkBounds(k.g.getImageData(0, 0, k.c.width, k.c.height));
    if (!crop) return;
    const out = document.createElement('canvas');
    out.width = crop.w;
    out.height = crop.h;
    out.getContext('2d')?.drawImage(k.c, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    onUse(out.toDataURL('image/png'), crop.w / crop.h);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-border-default bg-bg-surface">
        <DialogHeader>
          <DialogTitle>Your signature</DialogTitle>
          <DialogDescription>Draw it below, then place it on the page.</DialogDescription>
        </DialogHeader>
        <canvas
          ref={canvasRef}
          width={800}
          height={300}
          aria-label="Signature drawing area"
          className="h-40 w-full touch-none rounded-md border border-border-default bg-white"
          onPointerDown={(e) => {
            const k = ctx();
            if (!k) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = true;
            const p = point(e);
            k.g.beginPath();
            k.g.moveTo(p.x, p.y);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const k = ctx();
            if (!k) return;
            const p = point(e);
            k.g.lineTo(p.x, p.y);
            k.g.stroke();
            setEmpty(false);
          }}
          onPointerUp={() => {
            drawing.current = false;
          }}
        />
        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={clear}
            className="rounded-md px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={empty}
            onClick={use}
            className="rounded-md border border-border-default px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover disabled:opacity-50"
          >
            Use this signature
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The smallest box around every non-transparent pixel, with a little margin. */
export function inkBounds(img: { data: Uint8ClampedArray; width: number; height: number }) {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  return { x, y, w: Math.min(img.width, maxX + pad) - x, h: Math.min(img.height, maxY + pad) - y };
}
