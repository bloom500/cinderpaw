/**
 * #15: hardware-aware model recommendation for first-run onboarding.
 *
 * SystemBar already detects VRAM/RAM/Vulkan; this turns that detection into
 * a concrete "what should I download" suggestion shown in the onboarding
 * wizard's final step. The tiers mirror the fitness-score sweet spot
 * (50–80% memory utilization, see lib/fitScore.ts): the usable budget is
 * VRAM when a Vulkan GPU is present, otherwise system RAM with generous
 * headroom for the OS.
 */

import type { SystemInfo } from '@/lib/tauri';

export interface ModelRecommendation {
  /** e.g. "7–8B" */
  sizeClass: string;
  /** e.g. "Q4_K_M" */
  quant: string;
  /** Approximate GGUF download size to look for. */
  approxFileSize: string;
  /** One-sentence, plain-English rationale shown to the user. */
  rationale: string;
}

export function recommendModel(info: SystemInfo | null): ModelRecommendation | null {
  if (!info) return null;

  const hasGpu = info.supports_vulkan && info.vram_total_mb > 0;
  // Budget: on GPU we can fill most of the VRAM; on CPU leave the OS and the
  // app roughly half of the RAM.
  const budgetMb = hasGpu ? info.vram_total_mb * 0.8 : info.ram_total_mb * 0.5;
  const where = hasGpu
    ? `${Math.round(info.vram_total_mb / 1024)} GB VRAM (Vulkan)`
    : `${Math.round(info.ram_total_mb / 1024)} GB RAM (CPU only)`;

  if (budgetMb >= 18_000) {
    return {
      sizeClass: '13–14B',
      quant: 'Q4_K_M',
      approxFileSize: '~8–9 GB',
      rationale: `With ${where}, a 13–14B model at Q4_K_M fits comfortably and gives noticeably better answers than smaller models.`,
    };
  }
  if (budgetMb >= 9_000) {
    return {
      sizeClass: '7–8B',
      quant: 'Q4_K_M',
      approxFileSize: '~4.5–5.5 GB',
      rationale: `With ${where}, a 7–8B model at Q4_K_M is the sweet spot — strong quality at a comfortable speed.`,
    };
  }
  if (budgetMb >= 4_500) {
    return {
      sizeClass: '3–4B',
      quant: 'Q4_K_M',
      approxFileSize: '~2–2.5 GB',
      rationale: `With ${where}, a 3–4B model at Q4_K_M will run smoothly; larger models would crawl or not fit.`,
    };
  }
  return {
    sizeClass: '1–2B',
    quant: 'Q4_K_M',
    approxFileSize: '~1 GB',
    rationale: `With ${where}, stick to 1–2B models — or add a cloud API key (BYOK) for stronger models with zero local compute.`,
  };
}
