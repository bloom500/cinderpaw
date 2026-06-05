/**
 * Model fitness scoring — adapted from llmfit (github.com/AlexsJones/llmfit).
 *
 * Scores a local GGUF model across four dimensions:
 *   fit      — how efficiently the model fills available memory (sweet spot: 50-80%)
 *   quality  — quantization quality (Q8 ≫ Q4 ≫ Q2)
 *   speed    — estimated relative throughput (tok/s proxy from bandwidth / model size)
 *   context  — declared context window capability
 *
 * All inputs come from existing ModelInfo + SystemInfo types; no backend changes needed.
 */

import type { SystemInfo } from '@/lib/tauri';
import { QUANT_RANK } from '@/lib/modelUtils';

export type FitLevel = 'perfect' | 'good' | 'marginal' | 'too_big';
export type RunMode  = 'gpu' | 'cpu_offload' | 'cpu';

export interface FitComponents {
  fit:     number;   // 0-100
  quality: number;   // 0-100
  speed:   number;   // 0-100
  context: number;   // 0-100
}

export interface ModelFitScore {
  level:              FitLevel;
  runMode:            RunMode;
  score:              number;           // 0-100 overall
  components:         FitComponents;
  estimatedTokPerSec: number | null;    // null when model doesn't fit
  memUsedGb:          number;
  memAvailGb:         number;
  utilizationPct:     number;           // 0-999+
}

// Weights must sum to 1.0
const W_FIT     = 0.40;
const W_SPEED   = 0.30;
const W_QUALITY = 0.20;
const W_CONTEXT = 0.10;

export function scoreFit(
  sizeBytes: number,
  quant:     string | null | undefined,
  ctxLen:    number | null | undefined,
  sys:       SystemInfo,
): ModelFitScore {
  const modelGb = sizeBytes / 1_073_741_824;    // bytes → GB

  // Available capacity: prefer VRAM for GPU, else free RAM
  const hasGpu  = sys.vram_total_mb > 0;
  const availGb = hasGpu
    ? sys.vram_total_mb / 1024
    : Math.max(0, sys.ram_total_mb - sys.ram_used_mb) / 1024;

  const utilization = availGb > 0 ? modelGb / availGb : 2.0;

  // ── Fit component ─────────────────────────────────────────────────────────
  // Piecewise linear: sweet spot 50-80% utilization = 100 pts.
  // Tight range (80-100%) degrades smoothly; beyond capacity = 0.
  let fitScore: number;
  let level: FitLevel;

  if (utilization > 1.0) {
    fitScore = 0;
    level    = 'too_big';
  } else if (utilization > 0.95) {
    fitScore = Math.round(lerp(utilization, 0.95, 1.0,  30,   0));
    level    = 'marginal';
  } else if (utilization > 0.8) {
    fitScore = Math.round(lerp(utilization, 0.80, 0.95, 65,  30));
    level    = 'marginal';
  } else if (utilization >= 0.5) {
    fitScore = 100;
    level    = 'perfect';
  } else if (utilization >= 0.3) {
    fitScore = Math.round(lerp(utilization, 0.30, 0.50, 80, 100));
    level    = 'good';
  } else {
    fitScore = Math.round(lerp(utilization, 0.00, 0.30, 60,  80));
    level    = 'good';
  }

  // ── Quality component ─────────────────────────────────────────────────────
  const key      = (quant ?? '').toLowerCase();
  const rank     = QUANT_RANK[key] ?? 35;
  const qualityScore = Math.round(((rank - 8) / (110 - 8)) * 100);

  // ── Speed component ───────────────────────────────────────────────────────
  // Rough bandwidth proxy: discrete GPU with Vulkan ≈ 400 GB/s; CPU ≈ 50 GB/s.
  // TPS ≈ bandwidth / model_size. Target 30 tok/s = 100 pts.
  const bandwidthGBs = hasGpu && sys.supports_vulkan ? 400 : 50;
  const rawTps       = modelGb > 0 ? Math.round(bandwidthGBs / modelGb) : 0;
  const speedScore   = Math.min(100, Math.round((rawTps / 30) * 100));

  // ── Context component ─────────────────────────────────────────────────────
  const ctx = ctxLen ?? 0;
  const contextScore =
    ctx >= 131_072 ? 100 :
    ctx >=  32_768 ? 95  :
    ctx >=  16_384 ? 85  :
    ctx >=   8_192 ? 75  :
    ctx >=   4_096 ? 60  :
    ctx >        0 ? 40  :
    50;   // unknown → assume adequate

  // ── Overall (weighted) ────────────────────────────────────────────────────
  const score = Math.max(0, Math.min(100, Math.round(
    fitScore     * W_FIT     +
    qualityScore * W_QUALITY +
    speedScore   * W_SPEED   +
    contextScore * W_CONTEXT,
  )));

  // ── Run mode ──────────────────────────────────────────────────────────────
  const vramGb = sys.vram_total_mb / 1024;
  const runMode: RunMode =
    hasGpu && modelGb <= vramGb * 0.98 ? 'gpu'        :
    hasGpu                              ? 'cpu_offload' :
                                          'cpu';

  return {
    level,
    runMode,
    score,
    components: {
      fit:     fitScore,
      quality: qualityScore,
      speed:   speedScore,
      context: contextScore,
    },
    estimatedTokPerSec: level === 'too_big' ? null : rawTps,
    memUsedGb:          parseFloat(modelGb.toFixed(2)),
    memAvailGb:         parseFloat(availGb.toFixed(1)),
    utilizationPct:     Math.min(999, Math.round(utilization * 100)),
  };
}

// Piecewise lerp helper: map x ∈ [x0, x1] → y ∈ [y0, y1]
function lerp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x1 === x0) return y0;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}
