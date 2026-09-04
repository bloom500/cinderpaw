/**
 * USER loader — per-user personalization.
 *
 * Reads the onboarding record at `~/.cinderpaw/onboarding.json` (written by
 * the first-run wizard on the React side). The record carries:
 *   - userName:   how the user wants to be addressed
 *   - agentName:  what the user named the agent (defaults to "Cinderpaw")
 *   - agentCharacter: the three guided answers the user gave when they
 *                 made the agent (tone / focus / never). Optional.
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
import { cinderpawHome } from "../config.ts";
import { APP_HOME_DIR_NAME } from "../brand.ts";

export interface UserConfig {
  /** The user's chosen display name. Empty when no onboarding has happened. */
  userName: string;
  /** The user's chosen name for the agent. Falls back to "Cinderpaw". */
  agentName: string;
  /**
   * How the user asked their agent to be, in their own words. Each field
   * is one short answer to a guided question; any of them may be absent
   * because every question is skippable.
   */
  agentCharacter: AgentCharacter;
  /** True when the onboarding record exists AND has `completed: true`. */
  hasOnboarded: boolean;
}

export interface AgentCharacter {
  /** How the agent should talk. */
  tone?: string;
  /** What the user mostly works on. */
  focus?: string;
  /** The one thing the user does not want the agent to do. */
  never?: string;
}

interface OnboardingRecord {
  completed?: unknown;
  userName?: unknown;
  agentName?: unknown;
  agentCharacter?: unknown;
}

/**
 * Hard cap on a character answer, mirroring `MAX_CHARACTER_LEN` in
 * `src-tauri/src/commands/bootstrap.rs`. The writer already bounds and
 * strips these, but this file is on disk and a user can edit it by
 * hand: anything that lands in every system prompt gets checked where
 * it is read, not only where it was written.
 */
const MAX_CHARACTER_LEN = 120;

/** Clean one character answer, or drop it. Never throws. */
function readCharacterField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .split("")
    // eslint-disable-next-line no-control-regex
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join("")
    .trim()
    .slice(0, MAX_CHARACTER_LEN);
  return cleaned.length > 0 ? cleaned : undefined;
}

function readCharacter(value: unknown): AgentCharacter {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: AgentCharacter = {};
  const tone = readCharacterField(raw.tone);
  const focus = readCharacterField(raw.focus);
  const never = readCharacterField(raw.never);
  if (tone) out.tone = tone;
  if (focus) out.focus = focus;
  if (never) out.never = never;
  return out;
}

const ONBOARDING_PATH = `${APP_HOME_DIR_NAME}/onboarding.json`;
const DEFAULT_AGENT_NAME = "Cinderpaw";

/**
 * Load the user's onboarding record. Pure I/O — never throws. On any
 * failure (file missing, parse error, schema mismatch) returns a default
 * `UserConfig` so the agent can keep running.
 *
 * `homeDir` is the test-isolation seam (an OS home, the profile dir appended).
 * Omitting it — every production caller — resolves through `cinderpawHome()` so
 * CINDERPAW_HOME is honored; it used to read $HOME directly, which meant an
 * isolated profile still picked up the real user's onboarding record.
 */
export function loadUserConfig(homeDir?: string): UserConfig {
  const path =
    homeDir === undefined
      ? join(cinderpawHome(), "onboarding.json")
      : join(homeDir, ONBOARDING_PATH);
  if (!path || !existsSync(path)) {
    return { userName: "", agentName: DEFAULT_AGENT_NAME, agentCharacter: {}, hasOnboarded: false };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { userName: "", agentName: DEFAULT_AGENT_NAME, agentCharacter: {}, hasOnboarded: false };
  }
  let parsed: OnboardingRecord;
  try {
    parsed = JSON.parse(raw) as OnboardingRecord;
  } catch {
    return { userName: "", agentName: DEFAULT_AGENT_NAME, agentCharacter: {}, hasOnboarded: false };
  }

  const userName =
    typeof parsed.userName === "string" ? parsed.userName.trim() : "";
  const agentNameRaw =
    typeof parsed.agentName === "string" ? parsed.agentName.trim() : "";
  const agentName = agentNameRaw.length > 0 ? agentNameRaw : DEFAULT_AGENT_NAME;
  const hasOnboarded = parsed.completed === true;
  const agentCharacter = readCharacter(parsed.agentCharacter);

  return { userName, agentName, agentCharacter, hasOnboarded };
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
    ...characterLines(cfg.agentCharacter, agent),
    "",
  ].join("\n");
}

/**
 * Render the three guided answers as preferences, not as commands.
 *
 * The wording matters and is deliberate: these are the user's stated
 * preferences about style, not a new identity and not a licence to drop
 * the rules above. A user who answers "never tell me when you are
 * unsure" is asking for something SOUL.md refuses, and the last line
 * says which one wins — otherwise this feature becomes a way to talk an
 * agent out of its own honesty.
 */
function characterLines(character: AgentCharacter, agent: string): string[] {
  const answers: string[] = [];
  if (character.tone) {
    answers.push(`- The user asked for this tone: ${character.tone}.`);
  }
  if (character.focus) {
    answers.push(
      `- The user mostly works on: ${character.focus}. Assume that context when it helps, and drop it when it does not.`,
    );
  }
  if (character.never) {
    answers.push(`- The user asked ${agent} not to: ${character.never}.`);
  }
  if (answers.length === 0) return [];
  return [
    "",
    `When the user made ${agent}, they asked for the following. These are`,
    "preferences about style and emphasis:",
    ...answers,
    "- Where a preference here conflicts with SOUL.md — honesty above all,",
    "  saying when you are unsure, refusing what should be refused — SOUL.md",
    "  wins, and say so plainly rather than silently doing neither.",
  ];
}
