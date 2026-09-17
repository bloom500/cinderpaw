/**
 * Drawing PDF pages, and nothing else.
 *
 * pdf.js is large (the library plus a worker, over a megabyte), and almost no
 * session opens a PDF, so it is imported the first time one is shown rather
 * than with the app. The worker is served from our own origin as a bundled
 * file, which is what the app's CSP (`script-src 'self'`) allows.
 *
 * pdf.js 5 no longer compiles fonts with `eval` at all, which is what lets it
 * run under a CSP without 'unsafe-eval'. Keep it that way if this is upgraded:
 * a PDF is a file a stranger may have sent.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist';

let lib: Promise<typeof import('pdfjs-dist')> | null = null;

function pdfjs() {
  lib ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  });
  return lib;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function openPdf(base64: string): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  return m.getDocument({ data: base64ToBytes(base64) }).promise;
}

/**
 * Render one page into `canvas` at `cssWidth` pixels wide, sharp on a high-DPI
 * screen. Returns the page's size in points AS SHOWN (turned by its rotation),
 * which is what placed text is measured against.
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  index: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): Promise<{ widthPt: number; heightPt: number }> {
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(cssWidth * base.height) / base.width}px`;
  await page.render({ canvas, viewport }).promise;
  return { widthPt: base.width, heightPt: base.height };
}
