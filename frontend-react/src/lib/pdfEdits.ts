/**
 * What a person did to a PDF in the panel, as the list the sidecar applies.
 *
 * Kept apart from the component so the one piece with arithmetic in it (where
 * a box on screen ends up on the page) is testable without rendering a PDF.
 * The sidecar's `parsePdfEdits` is the other half of this contract.
 */

export type Overlay =
  | { id: string; page: number; kind: 'text'; x: number; y: number; size: number; text: string }
  | { id: string; page: number; kind: 'image'; x: number; y: number; width: number; height: number; png: string };

export type PdfEdit =
  | { type: 'text'; page: number; x: number; y: number; size: number; text: string }
  | { type: 'image'; page: number; x: number; y: number; width: number; height: number; png: string }
  | { type: 'delete_page'; page: number }
  | { type: 'rotate_page'; page: number; degrees: number }
  | { type: 'field'; name: string; value: string };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Overlays and changed fields, as edits. Empty text boxes are dropped: a box
 * someone clicked and never typed in is not something they meant to put in a
 * signed document.
 */
export function toEdits(overlays: Overlay[], fields: Record<string, string>, original: Record<string, string>): PdfEdit[] {
  const edits: PdfEdit[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (original[name] !== value) edits.push({ type: 'field', name, value });
  }
  for (const o of overlays) {
    if (o.kind === 'text') {
      if (!o.text.trim()) continue;
      edits.push({ type: 'text', page: o.page, x: clamp01(o.x), y: clamp01(o.y), size: o.size, text: o.text });
    } else {
      // The box may have been dragged partly off the page; what is saved is
      // the part that is on it, never a coordinate the sidecar will refuse.
      const x = clamp01(o.x);
      const y = clamp01(o.y);
      edits.push({
        type: 'image', page: o.page, x, y,
        width: clamp01(Math.min(o.width, 1 - x)),
        height: clamp01(Math.min(o.height, 1 - y)),
        png: o.png,
      });
    }
  }
  return edits;
}

/** A pointer position over a page element, as fractions of that page. */
export function pointerToPage(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }) {
  return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
}
