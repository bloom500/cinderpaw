/**
 * USER loader — per-user personalization.
 *
 * Reads the onboarding record at `~/.cinderpaw/onboarding.json` (written by
 * the first-run wizard on the React side). The record carries:
 *   - userName:   how the user wants to be addressed
 *   - agentName:  what the user named the agent (defaults to "Cinderpaw")
 *   - completed:  whether the wizard finished (false on skip)
 *
 * The loader never throws — any I/O error (missing file, malformed JSON,
 * permission denied) yields a "no personalization" result with sensible
 * defaults. A bad onboarding file must never brick the agent.
 *
 * The `buildUserPromptBlock` helper renders the loaded config as a USER
 * block that goes into the system prompt right after SOUL. The block
 * tells the model "address the user by X, refer to yourself as Y" —
 * which is the simplest possible personalization, applied at the prompt
 * level rather than the model level (no fine-tuning, no extra calls).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { feralHome } from "../config.ts";
import { APP_HOME_DIR_NAME } from "../brand.ts";

export interface UserConfig {
  /** The user's chosen display name. Empty when no onboarding has happened. */
  userName: string;
  /** The user's chosen name for the agent. Falls back to "Cinderpaw". */
  agentName: string;
  /** True when the onboarding record exists AND has `completed: true`. */
  hasOnboarded: boolean;
}

interface OnboardingRecord {
  completed?: unknown;
  userName?: unknown;
  agentName?: unknown;
}

const ONBOARDING_PATH = `${APP_HOME_DIR_NAME}/onboarding.json`;
const DEFAULT_AGENT_NAME = "Cinderpaw";

/**
 * Load the user's onboarding record. Pure I/O — never throws. On any
 * failure (file missing, parse error, schema mismatch) returns a default
 * `UserConfig` so the agent can keep running.
 *
 * `homeDir` is the test-isolation seam (an OS home, the profile dir appended).
 * Omitting it — every production caller — resolves through `feralHome()` so
 * CINDERPAW_HOME is honored; it used to read $HOME directly, which meant an
 * isolated profile still picked up the real user's onboarding record.
 */
export function loadUserConfig(homeDir?: string): UserConfig {
  const path =
    homeDir === undefined
      ? join(feralHome(), "onboarding.json")
      : join(homeDir, ONBOARDING_PATH);
  if (!path || !existsSync(path)) {
    return { userName: "", agentName: DEFAULT_AGENT_NAME, hasOnboarded: false };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { userName: "", agentName: DEFAULT_AGENT_NAME, hasOnboarded: false };
  }
  let parsed: OnboardingRecord;
  try {
    parsed = JSON.parse(raw) as OnboardingRecord;
  } catch {
    return { userName: "", agentName: DEFAULT_AGENT_NAME, hasOnboarded: false };
  }

  const userName =
    typeof parsed.userName === "string" ? parsed.userName.trim() : "";
  const agentNameRaw =
    typeof parsed.agentName === "string" ? parsed.agentName.trim() : "";
  const agentName = agentNameRaw.length > 0 ? agentNameRaw : DEFAULT_AGENT_NAME;
  const hasOnboarded = parsed.completed === true;

  return { userName, agentName, hasOnboarded };
}

/**
 * Render a UserConfig as a USER block to append to the system prompt.
 * Returns an empty string when the user has not onboarded — the prompt
 * stays as-is in that case (no personalization, but no awkward "USER
 * (none)" placeholder either).
 *
 * The block uses a soft, second-person tone — telling the model what
 * to call the user and itself, without rigid scripts.
 */
export function buildUserPromptBlock(cfg: UserConfig): string {
  if (!cfg.hasOnboarded) return "";

  const user = cfg.userName.length > 0 ? cfg.userName : "the user";
  const agent = cfg.agentName.length > 0 ? cfg.agentName : DEFAULT_AGENT_NAME;

  return [
    "## Personalization (USER.md)",
    "",
    `The user calls themselves "${user}". The user has named the agent "${agent}".`,
    `- When addressing the user, use their name ("${user}", or a natural-language equivalent).`,
    `- When referring to yourself, use the name "${agent}" — the user chose this.`,
    `- This is a nickname, not a persona override: SOUL.md still governs identity,`,
    `  honesty, and behavior. The agent is still an AI assistant.`,
    `- If the user asks "what's your name?", answer "${agent}".`,
    "",
  ].join("\n");
}
