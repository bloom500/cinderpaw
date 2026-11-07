/**
 * A tool result too big for the model's context goes to a file; the model gets
 * the start, the end, and where the rest is (DeepSeek Harness's "spill", read
 * 4 Nov). Before, a page or a command's output went into the prompt whole,
 * however long, which is how a single fetch could push a turn past the window.
 *
 * The file is in the agent's own scratchpad, which read_file and grep already
 * reach, so nothing new is opened to the model.
 *
 * ponytail: a character cut, not a token count; ~40k characters is ~10k tokens
 * for English and less for Romanian. A per-model token budget is the upgrade.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../config.ts";

/** Results longer than this are spilled. */
export const SPILL_AT = 40_000;
const HEAD = 16_000;
const TAIL = 6_000;

export function spillIfLarge(tool: string, text: string, dir: string = join(scratchRoot(), "tool-results")): string {
  if (text.length <= SPILL_AT) return text;
  const hidden = text.length - HEAD - TAIL;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${tool.replace(/[^a-z0-9_-]/gi, "_")}-${Date.now()}.txt`);
    writeFileSync(file, text, "utf8");
    return (
      `${text.slice(0, HEAD)}\n\n[… ${hidden} characters not shown here. The whole result is saved in ${file}: ` +
      `grep it for the part you need, or read_file it.]\n\n${text.slice(-TAIL)}`
    );
  } catch {
    // Better a cut the model is told about than a prompt that does not fit.
    return `${text.slice(0, HEAD)}\n\n[… ${hidden} characters cut; the full result could not be saved.]\n\n${text.slice(-TAIL)}`;
  }
}
