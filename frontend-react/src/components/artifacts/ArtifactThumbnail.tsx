import { useEffect, useMemo, useRef, useState } from 'react';
import { peekArtifact, shownKind, type ArtifactRow } from '@/stores/artifacts';
import { plainText } from '@/lib/artifactSections';
import { cn } from '@/lib/utils';
import { ArtifactCover } from './ArtifactCover';

const READABLE = new Set(['document', 'markdown', 'docx', 'html', 'app', 'table', 'code', 'json', 'image']);
// A thumbnail must not pull a huge file through the sidecar just to fill a tile.
const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=\r\n]+$/;

export function artifactImageSource(content: string): string | null {
  return IMAGE.test(content) ? content : null;
}

/** Static words from the document, never its scripts, styles or event handlers. */
function documentText(kind: string, content: string): string {
  content = content.slice(0, 16_000);
  if (kind === 'markdown') {
    // A table row reads "Monday · Oatmeal · Soup", and its |---| rule goes:
    // the gallery tile showed the raw pipes of a meal-plan table (24 Oct).
    return content.split(/\r?\n/).filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line))
      .map((line) => /^\s*\|.*\|\s*$/.test(line) ? line.trim().slice(1, -1).split('|').map((c) => c.trim()).join(' · ') : line)
      .map((line) => plainText(line.replace(/^\s*(?:#{1,6}|[-+*])\s+/, '')))
      .filter(Boolean).slice(0, 8).join('\n\n').slice(0, 1400);
  }
  const words = content.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '')
    .replace(/<br\s*\/?>|<\/(?:h[1-6]|p|li|div|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '').slice(0, 6000);
  // Escape remaining angle brackets before decoding entities. The parser sees
  // text only, so even malformed markup cannot load images or other resources.
  const decoded = new DOMParser().parseFromString(words.replace(/</g, '&lt;'), 'text/html').body.textContent ?? '';
  return decoded.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean).slice(0, 8).join('\n\n').slice(0, 1400);
}

/** The table formats already accepted by artifact export, bounded to a tile. */
function tableRows(content: string): string[][] | null {
  if (content.length > 512_000) return null;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  let rows: unknown[][];
  if (Array.isArray(value) && Array.isArray(value[0])) {
    rows = value.slice(0, 5);
  } else if (Array.isArray(value) && value[0] && typeof value[0] === 'object') {
    const keys = Object.keys(value[0]).slice(0, 4);
    rows = [keys, ...value.slice(0, 4).map((row) => keys.map((key) =>
      row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : ''))];
  } else if (value && typeof value === 'object') {
    const table = value as Record<string, unknown>;
    if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) return null;
    const columns = table.columns.slice(0, 4);
    rows = [columns, ...table.rows.slice(0, 4).map((row) =>
      Array.isArray(row) ? row : columns.map((key) =>
        row && typeof row === 'object' ? (row as Record<string, unknown>)[String(key)] : ''))];
  } else return null;
  return rows.filter(Array.isArray).map((row) => row.slice(0, 4).map((cell) =>
    (cell == null ? '' : typeof cell === 'object' ? JSON.stringify(cell) ?? '' : String(cell)).slice(0, 72)));
}

/**
 * Content in the Dock and overview, read without opening or changing the viewer.
 * No live frames: looking at a list must not execute the apps in it.
 */
export function ArtifactThumbnail({ row, version = row.version, content, size = 'sm', className }: {
  row: ArtifactRow;
  version?: number;
  /** The overview already has the selected version: do not read it again. */
  content?: string;
  /** `page`: the Artifacts gallery's card, where a document's first page fills
   *  the width from the top and runs off the bottom, as a page seen from above. */
  size?: 'sm' | 'lg' | 'page';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [peek, setPeek] = useState<{ key: string; content: string } | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const key = `${row.id}@${version}`;
  const readable = READABLE.has(row.kind) && row.bytes <= MAX_BYTES;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '96px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (content !== undefined || !visible || !readable) return;
    let live = true;
    peekArtifact(row.id, version).then(
      (result) => { if (live) setPeek({ key, content: result.content }); },
      () => { if (live) setPeek(null); },
    );
    return () => { live = false; };
  }, [row.id, version, key, readable, visible, content]);

  const source = content ?? (peek?.key === key ? peek.content : undefined);
  const kind = shownKind(row.kind, source ?? '');
  const words = useMemo(() => source !== undefined && readable &&
    ['document', 'markdown', 'docx', 'html', 'app'].includes(kind)
    ? documentText(kind, source) : '', [kind, source, readable]);
  const rows = useMemo(() => kind === 'table' && source !== undefined && readable
    ? tableRows(source) : null, [kind, source, readable]);
  const image = kind === 'image' && source !== undefined && readable ? artifactImageSource(source) : null;
  const code = source !== undefined && readable && ['code', 'json', 'table'].includes(kind)
    ? source.slice(0, 4000).split(/\r?\n/).slice(0, 6).join('\n') : '';
  const preview = source !== undefined && (words || rows?.length || code || (image && failedImage !== image));

  return (
    <div ref={ref} aria-hidden="true" data-artifact-thumbnail={row.id}
      className={cn('pointer-events-none relative flex items-center justify-center overflow-hidden bg-bg-active/60', className)}>
      {!preview ? (
        <ArtifactCover title={row.title} kind={row.kind} size={size === 'sm' ? 'sm' : 'lg'} className="h-full w-full" />
      ) : image && failedImage !== image ? (
        <img src={image} alt="" loading="lazy" decoding="async" onError={() => setFailedImage(image)}
          className="h-full w-full object-contain" />
      ) : rows?.length ? (
        <div className="w-full px-3">
          <table className="w-full table-fixed border-collapse bg-bg-elevated text-left text-micro text-text-primary">
            <tbody>{rows.map((cells, i) => (
              <tr key={i} className={i === 0 ? 'bg-brand/10 font-semibold' : undefined}>
                {cells.map((cell, j) => <td key={j} className="truncate border border-border-subtle px-2 py-1">{cell}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : code ? (
        <pre className="h-full w-full overflow-hidden p-3 font-mono text-micro leading-relaxed text-text-secondary">{code}</pre>
      ) : (
        <div className="absolute left-1/2 top-1/2 h-[360px] w-[260px] overflow-hidden rounded-sm border border-[#E4D6C8] bg-[#FFFDFA] p-5 text-[#2F2A26] shadow-sm"
          style={size === 'page'
            ? { top: 16, transformOrigin: 'top center', transform: 'translateX(-50%) scale(0.85)' }
            : { transform: `translate(-50%, -50%) scale(${size === 'lg' ? 0.5 : 0.28})` }}>
          <p className="whitespace-pre-line text-micro leading-relaxed first-line:font-display first-line:text-xl">{words}</p>
        </div>
      )}
    </div>
  );
}
