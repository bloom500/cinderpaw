import type { HfFile, SystemInfo } from '@/lib/tauri';

// ── Quantization rank — higher = better quality ──────────────────────────────
export const QUANT_RANK: Record<string, number> = {
  f32: 110, f16: 100, fp16: 100, bf16: 100,
  q8_0: 80, q8: 80,
  q6_k: 70, q6: 70,
  q5_k_m: 62, q5_k: 60, q5: 58,
  q4_k_m: 55, q4_k: 52, q4_0: 40, q4: 40,
  q3_k_m: 35, q3_k: 32, q3: 30,
  iq2: 20, q2_k: 20, q2: 18,
  iq1: 10, q1: 8,
};

export function extractQuant(filename: string): string {
  const noExt = filename.replace(/\.gguf$/i, '');
  // Match quant tokens separated by . or - : Q4_K_M, IQ2_XXS, BF16, F16, F32, Q4_0 …
  const m = noExt.match(/[-.]((IQ\d[\w]*|Q\d[\w]*|BF\d+|F\d+))(?:[-.]|$)/i);
  return m ? m[1].toUpperCase() : 'N/A';
}

export function quantQualityRank(filename: string): number {
  const quant = extractQuant(filename).toLowerCase();
  return QUANT_RANK[quant] ?? 35;
}

export function cleanModelName(filename: string): string {
  const lower = filename.toLowerCase();
  const noExt = lower.endsWith('.gguf') ? lower.slice(0, -5) : lower;
  const lastDot = noExt.lastIndexOf('.');
  const cleaned =
    lastDot !== -1 &&
    (noExt[lastDot + 1] === 'q' ||
      noExt.slice(lastDot + 1).startsWith('iq') ||
      noExt.slice(lastDot + 1).startsWith('f') ||
      noExt.slice(lastDot + 1).startsWith('bf'))
      ? noExt.slice(0, lastDot)
      : noExt;
  return cleaned
    .split(/[-_]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export function quantToQuality(quant: string): string {
  const q = quant.toLowerCase();
  if (q.includes('iq1')) return 'Ultra fast (lower quality)';
  if (q.includes('iq2') || q.includes('q2_k') || q.startsWith('q2')) return 'Fastest';
  if (q.includes('q3')) return 'Fast';
  if (q.includes('q4_k_m') || q.includes('q4_k')) return 'Balanced quality';
  if (q.includes('q4')) return 'Standard quality';
  if (q.includes('q5')) return 'High quality';
  if (q.includes('q6')) return 'Very high quality';
  if (q.includes('q8')) return 'Best quality';
  if (q.includes('f16') || q.includes('fp16') || q.includes('bf16')) return 'Full precision';
  if (q.includes('f32')) return 'Full precision (32-bit)';
  return 'Standard';
}

export type QuantVariant = 'full' | 'high' | 'balanced' | 'small' | 'tiny';

export function quantToBadge(quant: string): { label: string; variant: QuantVariant } {
  const q = quant.toLowerCase();
  if (q.includes('f16') || q.includes('fp16') || q.includes('bf16') || q.includes('f32'))
    return { label: 'Full', variant: 'full' };
  if (q.includes('q8') || q.includes('q6'))
    return { label: 'High', variant: 'high' };
  if (q.includes('q4_k') || q.includes('q5'))
    return { label: 'Balanced', variant: 'balanced' };
  if (q.includes('q4') || q.includes('q3') || q.includes('iq2') || q.includes('q2'))
    return { label: 'Small', variant: 'small' };
  if (q.includes('iq1') || q.includes('q1'))
    return { label: 'Tiny', variant: 'tiny' };
  return { label: 'Small', variant: 'small' };
}

export function sizeGb(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb < 1) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${gb.toFixed(1)} GB`;
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

export function shortRepo(id: string): string {
  return id.split('/').pop() ?? id;
}

export function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const rest = md.slice(3);
  const closeIdx = rest.indexOf('\n---');
  if (closeIdx === -1) return md;
  return rest.slice(closeIdx + 4).trimStart();
}

// ── Hardware compatibility ────────────────────────────────────────────────────
export type Compat = 'fits' | 'slow' | 'no';

export function compatLevel(bytes: number, sys: SystemInfo | null): Compat | null {
  if (!sys) return null;
  const capacityMb = sys.vram_total_mb > 0
    ? sys.vram_total_mb
    : Math.max(0, sys.ram_total_mb - sys.ram_used_mb);
  const capacityBytes = capacityMb * 1024 * 1024;
  if (capacityBytes === 0) return 'no';
  const comfortable = (capacityBytes * 7) / 10;
  if (bytes <= comfortable) return 'fits';
  if (bytes <= capacityBytes) return 'slow';
  return 'no';
}

function isStandaloneGguf({ rfilename: filename }: HfFile): boolean {
  // Exclude split shards (e.g. BF16/model-00001-of-00002.gguf) and subdirectory files.
  // These are partial files — their individual size is not the full model size.
  if (filename.includes('/')) return false;
  if (/\d+-of-\d+/i.test(filename)) return false;
  return true;
}

export function pickFittedFile(files: HfFile[], sys: SystemInfo | null): HfFile | null {
  if (files.length === 0) return null;

  // Prefer standalone (non-split) files; fall back to all if none exist
  const pool = files.filter(isStandaloneGguf);
  const candidates = pool.length > 0 ? pool : files;

  const withSize = candidates.filter((f) => f.size && f.size > 0);

  // Full-precision quants (F32, F16, BF16) are deprioritised — even if they
  // technically fit in VRAM they are rarely what the user wants from a GGUF hub.
  const isFullPrecision = (f: HfFile) => {
    const q = extractQuant(f.rfilename).toLowerCase();
    return q === 'f32' || q === 'f16' || q === 'fp16' || q === 'bf16' || q === 'n/a';
  };

  if (sys && withSize.length > 0) {
    const targetQuant = globalFittedQuant(sys);

    const fits = withSize.filter((f) => compatLevel(f.size!, sys) === 'fits');
    if (fits.length > 0) {
      const fitsQ = fits.filter((f) => !isFullPrecision(f));
      const fitsPool = fitsQ.length > 0 ? fitsQ : fits;
      const exact = fitsPool.find((f) => extractQuant(f.rfilename) === targetQuant);
      if (exact) return exact;
      return fitsPool.reduce((best, f) =>
        quantQualityRank(f.rfilename) > quantQualityRank(best.rfilename) ? f : best,
      );
    }

    const slow = withSize.filter((f) => compatLevel(f.size!, sys) === 'slow');
    if (slow.length > 0) {
      const slowQ = slow.filter((f) => !isFullPrecision(f));
      const slowPool = slowQ.length > 0 ? slowQ : slow;
      return slowPool.reduce((best, f) => (f.size! < best.size! ? f : best));
    }

    const nofitQ = withSize.filter((f) => !isFullPrecision(f));
    const nofitPool = nofitQ.length > 0 ? nofitQ : withSize;
    return nofitPool.reduce((best, f) => (f.size! < best.size! ? f : best));
  }

  if (withSize.length > 0) {
    const rankQ = withSize.filter((f) => !isFullPrecision(f));
    const rankPool = rankQ.length > 0 ? rankQ : withSize;
    return rankPool.reduce((best, f) =>
      quantQualityRank(f.rfilename) > quantQualityRank(best.rfilename) ? f : best,
    );
  }

  const noSizeQ = candidates.filter((f) => !isFullPrecision(f));
  const noSizePool = noSizeQ.length > 0 ? noSizeQ : candidates;
  return noSizePool.reduce((best, f) =>
    quantQualityRank(f.rfilename) > quantQualityRank(best.rfilename) ? f : best,
  );
}

export function globalFittedQuant(sys: SystemInfo | null): string {
  const mb = sys
    ? sys.vram_total_mb > 0
      ? sys.vram_total_mb
      : Math.max(0, sys.ram_total_mb - sys.ram_used_mb)
    : 8192;
  if (mb >= 32768) return 'Q8_0';
  if (mb >= 24576) return 'Q6_K';
  if (mb >= 12288) return 'Q5_K_M';
  if (mb >= 8192) return 'Q4_K_M';
  if (mb >= 4096) return 'Q3_K_M';
  return 'Q2_K';
}

const THINKING_PATTERNS = /think|qwq|deepseek-r/i;

export function modelSupportsThinking(name: string): boolean {
  return THINKING_PATTERNS.test(name);
}
