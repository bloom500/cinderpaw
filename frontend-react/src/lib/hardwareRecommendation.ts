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
  // Plain words (4 Nov tour): "8 GB VRAM (Vulkan), a 4B model at Q4_K_M" was
  // read by strangers on the very first screen.
  const where = hasGpu
    ? `graphics card (${Math.round(info.vram_total_mb / 1024)} GB)`
    : `computer (${Math.round(info.ram_total_mb / 1024)} GB of memory, no graphics card)`;

  if (budgetMb >= 18_000) {
    return {
      sizeClass: '13–14B',
      quant: 'Q4_K_M',
      approxFileSize: '~8–9 GB',
      rationale: `Your ${where} can run a model big enough to use Cinderpaw's tools well.`,
    };
  }
  if (budgetMb >= 9_000) {
    return {
      sizeClass: '7–8B',
      quant: 'Q4_K_M',
      approxFileSize: '~4.5–5.5 GB',
      rationale: `Your ${where} can run a small model. It is fast, but small models make mistakes with Cinderpaw's tools. For your first day, signing in online works better.`,
    };
  }
  if (budgetMb >= 4_500) {
    return {
      sizeClass: '3–4B',
      quant: 'Q4_K_M',
      approxFileSize: '~2–2.5 GB',
      rationale: `Your ${where} can run only a small model, and small models make mistakes with Cinderpaw's tools. For your first day, signing in online works better.`,
    };
  }
  return {
    sizeClass: '1–2B',
    quant: 'Q4_K_M',
    approxFileSize: '~1 GB',
    rationale: `Your ${where} is too small for a model that can use Cinderpaw's tools. Sign in online instead; it costs this computer nothing.`,
  };
}
