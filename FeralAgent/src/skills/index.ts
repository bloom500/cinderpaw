/**
 * Skills subsystem — public surface.
 *
 * Imported as `from "../skills/index.ts"` so callers don't have to
 * know which file holds what.
 */

export { SkillsStorage } from "./storage.ts";
export type { SkillManifest } from "./storage.ts";
export { SkillAutoCreator } from "./auto-create.ts";
export type { SkillAutoCreatorConfig, SkillCandidate } from "./auto-create.ts";
export { SkillSelfImprover } from "./self-improve.ts";
export type { SkillSelfImproverConfig, RefineResult } from "./self-improve.ts";
