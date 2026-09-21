import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Loader2, PenLine, RotateCw, Trash2, Type, X } from 'lucide-react';
import { ArtifactAction } from '@/components/ai-elements/artifact';
import { ScrollArea } from '@/components/ui/scroll-area';
import { openPdf, renderPage } from '@/lib/pdfRender';
import { pointerToPage, toEdits, type Overlay, type PdfEdit } from '@/lib/pdfEdits';
import { cn } from '@/lib/utils';
import { SignaturePad } from './SignaturePad';

export interface PdfFieldRow {
  name: string;
  type: string;
  value: string;
}

/**
 * A PDF on screen: read it, and when editing, write on it.
 *
 * Two modes, and the split is deliberate. Viewing offers the page actions
 * (turn, remove), which save at once, because they change what every later
 * placement is measured against. Editing offers what goes ON a page (text, a
 * signature, form fields), held here until Save, and reported upward as the
 * edit list after every change so the store's save and conflict handling work
 * for a PDF exactly as they do for a document.
 *
 * It cannot change the words already in the PDF. That is not missing polish:
 * a PDF stores glyphs at positions, not sentences, and the panel says so
 * rather than offering a text cursor that would do nothing.
 */
export function PdfEditor({
  base64,
  fields,
  editing,
  busy,
  onDraft,
  onPageAction,
}: {
  base64: string;
  fields: PdfFieldRow[];
  editing: boolean;
  busy: boolean;
  /** Editing: the current edit list, as the JSON the sidecar takes. */
  onDraft?: (json: string) => void;
  /** Viewing: turn or remove a page, saved immediately. */
  onPageAction?: (edit: PdfEdit) => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const original = Object.fromEntries(fields.map((f) => [f.name, f.value]));
  const [values, setValues] = useState<Record<string, string>>(original);
  const [mode, setMode] = useState<null | 'text' | 'sign'>(null);
  const [signature, setSignature] = useState<{ png: string; aspect: number } | null>(null);
  const [padOpen, setPadOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setFailed(null);
    openPdf(base64)
      .then((d) => alive && setDoc(d))
      .catch(() => alive && setFailed('This PDF could not be opened. It may be damaged or password-protected.'));
    return () => {
      alive = false;
    };
  }, [base64]);

  // Pages are drawn at the panel's width, and redrawn when it is resized.
  // Measured on the component root, not on the page column inside the scroll
  // area: Radix lays that column out as a table, so it grows to the widest
  // page and never shrinks back, and pages drawn wide once stayed wide after
  // the panel was narrowed (20 Sep). The root follows the panel both ways.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, el.clientWidth - 32)); // side padding + the scroll bar
    // Measured once now, so the first pages draw without waiting a frame.
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A fresh edit session starts clean.
  useEffect(() => {
    if (!editing) {
      setOverlays([]);
      setMode(null);
    }
    setValues(Object.fromEntries(fields.map((f) => [f.name, f.value])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, base64]);

  const report = useCallback(
    (next: Overlay[], nextValues: Record<string, string>) => {
      onDraft?.(JSON.stringify({ edits: toEdits(next, nextValues, original) }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onDraft, base64],
  );

  const update = (next: Overlay[]) => {
    setOverlays(next);
    report(next, values);
  };

  const place = (page: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (!mode || e.target !== e.currentTarget) return;
    const at = pointerToPage(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    const id = `o${Date.now()}`;
    if (mode === 'text') {
      update([...overlays, { id, page, kind: 'text', x: at.x, y: at.y, size: 12, text: '' }]);
    } else if (signature) {
      const pageRect = e.currentTarget.getBoundingClientRect();
      const w = 0.3;
      const h = Math.min(0.3, (w * pageRect.width) / signature.aspect / pageRect.height);
      update([...overlays, { id, page, kind: 'image', x: Math.min(at.x, 1 - w), y: Math.min(at.y, 1 - h), width: w, height: h, png: signature.png }]);
    }
    setMode(null);
  };

  if (failed) return <p className="px-3 py-3 text-2xs text-(--warning)">{failed}</p>;

  return (
    <div ref={boxRef} className="flex min-h-0 flex-1 flex-col">
      {editing && (
        <div role="toolbar" aria-label="PDF tools" className="flex items-center gap-1 border-b border-border-subtle px-2 py-1">
          <ArtifactAction
            tooltip="Add text" icon={Type} aria-pressed={mode === 'text'}
            className={cn(mode === 'text' && 'bg-bg-hover text-text-primary')}
            onClick={() => setMode(mode === 'text' ? null : 'text')}
          />
          <ArtifactAction
            tooltip="Sign" icon={PenLine} aria-pressed={mode === 'sign'}
            className={cn(mode === 'sign' && 'bg-bg-hover text-text-primary')}
            onClick={() => (signature ? setMode(mode === 'sign' ? null : 'sign') : setPadOpen(true))}
          />
          {signature && (
            <button
              type="button"
              onClick={() => setPadOpen(true)}
              className="rounded-md px-2 py-1 text-2xs text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              Redraw signature
            </button>
          )}
          <p className="ml-auto truncate text-2xs text-text-muted">
            {mode === 'text' ? 'Click where the text goes' : mode === 'sign' ? 'Click where the signature goes' : "Existing text can't be changed"}
          </p>
        </div>
      )}

      {editing && fields.length > 0 && (
        // Forms first: a form that needs filling is usually the reason the PDF was opened.
        <fieldset className="flex flex-col gap-1.5 border-b border-border-subtle px-3 py-2">
          <legend className="sr-only">Form fields</legend>
          {fields.map((f) => (
            <label key={f.name} className="flex items-center gap-2 text-2xs text-text-muted">
              <span className="w-28 shrink-0 truncate" title={f.name}>{f.name}</span>
              {f.type === 'checkbox' ? (
                <input
                  type="checkbox"
                  checked={values[f.name] === 'true'}
                  onChange={(e) => {
                    const next = { ...values, [f.name]: String(e.target.checked) };
                    setValues(next);
                    report(overlays, next);
                  }}
                />
              ) : (
                <input
                  type="text"
                  value={values[f.name] ?? ''}
                  onChange={(e) => {
                    const next = { ...values, [f.name]: e.target.value };
                    setValues(next);
                    report(overlays, next);
                  }}
                  className="min-w-0 flex-1 rounded-md border border-border-default bg-transparent px-2 py-1 text-xs text-text-primary"
                />
              )}
            </label>
          ))}
        </fieldset>
      )}

      <ScrollArea className="flex-1">
        <div className="flex flex-col items-center gap-3 px-3 py-3">
          {!doc || width === 0 ? (
            <Loader2 size={16} className="my-6 animate-spin text-text-muted" />
          ) : (
            Array.from({ length: doc.numPages }, (_, i) => (
              <Page
                key={`${base64.length}-${i}`}
                doc={doc}
                index={i}
                count={doc.numPages}
                width={width}
                busy={busy}
                placing={editing && mode !== null}
                onPlace={(e) => place(i, e)}
                onPageAction={editing ? undefined : onPageAction}
              >
                {overlays.filter((o) => o.page === i).map((o) => (
                  <OverlayBox
                    key={o.id}
                    overlay={o}
                    onChange={(next) => update(overlays.map((x) => (x.id === o.id ? next : x)))}
                    onRemove={() => update(overlays.filter((x) => x.id !== o.id))}
                  />
                ))}
              </Page>
            ))
          )}
        </div>
      </ScrollArea>

      <SignaturePad
        open={padOpen}
        onOpenChange={setPadOpen}
        onUse={(png, aspect) => {
          setSignature({ png, aspect });
          setMode('sign');
        }}
      />
    </div>
  );
}

function Page({
  doc, index, count, width, busy, placing, onPlace, onPageAction, children,
}: {
  doc: PDFDocumentProxy;
  index: number;
  count: number;
  width: number;
  busy: boolean;
  placing: boolean;
  onPlace: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPageAction?: (edit: PdfEdit) => void;
  children: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sizePt, setSizePt] = useState<{ widthPt: number; heightPt: number } | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    let alive = true;
    void renderPage(doc, index, canvasRef.current, width).then((s) => alive && setSizePt(s));
    return () => {
      alive = false;
    };
  }, [doc, index, width]);

  return (
    <section aria-label={`Page ${index + 1} of ${count}`} className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-2xs text-text-muted">
        <span className="flex-1">{`Page ${index + 1} of ${count}`}</span>
        {onPageAction && (
          <ArtifactAction
            tooltip="Turn page" icon={RotateCw} disabled={busy}
            onClick={() => onPageAction({ type: 'rotate_page', page: index, degrees: 90 })}
          />
        )}
        {onPageAction && count > 1 && (
          <ArtifactAction
            tooltip="Remove page" icon={Trash2} disabled={busy}
            onClick={() => onPageAction({ type: 'delete_page', page: index })}
          />
        )}
      </div>
      <div
        data-testid={`pdf-page-${index}`}
        className={cn('relative bg-white shadow-sm', placing && 'cursor-crosshair')}
        style={{ width, ['--pt' as string]: sizePt ? `${width / sizePt.widthPt}px` : '1px' }}
        onPointerDown={onPlace}
      >
        <canvas ref={canvasRef} className="pointer-events-none block" />
        {children}
      </div>
    </section>
  );
}

/** A placed box: dragged by its body, a signature resized by its corner. */
function OverlayBox({
  overlay: o,
  onChange,
  onRemove,
}: {
  overlay: Overlay;
  onChange: (next: Overlay) => void;
  onRemove: () => void;
}) {
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; ow: number; oh: number; resize: boolean } | null>(null);

  const start = (e: React.PointerEvent, resize: boolean) => {
    // Text boxes are dragged by their frame, so a click inside still places the caret.
    if (o.kind === 'text' && !resize && (e.target as HTMLElement).tagName === 'INPUT') return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      x: e.clientX, y: e.clientY, ox: o.x, oy: o.y,
      ow: o.kind === 'image' ? o.width : 0, oh: o.kind === 'image' ? o.height : 0, resize,
    };
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const page = e.currentTarget.closest('[data-testid^="pdf-page-"]')?.getBoundingClientRect();
    if (!d || !page) return;
    const dx = (e.clientX - d.x) / page.width;
    const dy = (e.clientY - d.y) / page.height;
    if (d.resize && o.kind === 'image') {
      const w = Math.max(0.05, Math.min(1 - o.x, d.ow + dx));
      onChange({ ...o, width: w, height: (d.oh * w) / d.ow });
    } else {
      onChange({ ...o, x: Math.max(0, Math.min(0.98, d.ox + dx)), y: Math.max(0, Math.min(0.98, d.oy + dy)) });
    }
  };
  const end = () => {
    drag.current = null;
  };

  return (
    <div
      className="group absolute cursor-move rounded-sm outline-1 outline-dashed outline-brand/60"
      style={{
        left: `${o.x * 100}%`,
        top: `${o.y * 100}%`,
        ...(o.kind === 'image' ? { width: `${o.width * 100}%`, height: `${o.height * 100}%` } : {}),
      }}
      onPointerDown={(e) => start(e, false)}
      onPointerMove={move}
      onPointerUp={end}
    >
      {o.kind === 'text' ? (
        <input
          autoFocus
          aria-label="Text on page"
          value={o.text}
          placeholder="Type here"
          onChange={(e) => onChange({ ...o, text: e.target.value })}
          className="bg-transparent px-0.5 leading-none text-black outline-hidden placeholder:text-black/40"
          style={{ fontSize: `calc(var(--pt) * ${o.size})`, width: `${Math.max(6, o.text.length + 1)}ch` }}
        />
      ) : (
        <>
          <img src={o.png} alt="Your signature" draggable={false} className="pointer-events-none size-full object-contain" />
          <span
            aria-hidden
            className="absolute -bottom-1 -right-1 size-3 cursor-nwse-resize rounded-full bg-brand"
            onPointerDown={(e) => start(e, true)}
            onPointerMove={move}
            onPointerUp={end}
          />
        </>
      )}
      <button
        type="button"
        aria-label="Remove"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        className="absolute -right-2 -top-2 hidden size-4 items-center justify-center rounded-full bg-bg-elevated text-text-muted group-hover:flex"
      >
        <X size={12} />
      </button>
    </div>
  );
}
