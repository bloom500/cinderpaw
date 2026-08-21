/**
 * Rename the browser-storage keys, once, at startup.
 *
 * The keys were named after the app, so renaming the app orphans them. Nothing
 * would look broken: the code would ask for `cinderpaw.onboarding`, find
 * nothing, and conclude the person is new — so the onboarding wizard reappears
 * for someone who finished it months ago, the dismissed notices come back, and
 * the selected agent resets to whichever one happens to be first. Every one of
 * those reads as "the update wiped my settings".
 *
 * Copy, then remove the old key — and only then. Copying first means an
 * interruption leaves both, and the next run finishes the job; removing first
 * would leave neither. A copy that was SKIPPED removes nothing at all.
 *
 * Must run before any module that reads these keys is evaluated, which is a
 * stronger requirement than "before React mounts" and is why `main.tsx` imports
 * `./lib/bootStorage` ahead of everything else. A zustand store rehydrating
 * first would find the new key empty, write its defaults there, and turn this
 * function into a no-op that had already been marked done.
 *
 * Anything that throws here is
 * swallowed: storage can be unavailable (private mode, a locked-down profile,
 * quota exhausted) and a settings copy is never worth refusing to start over.
 */

/** Old key → new key. Only keys the app itself owns. */
const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['feral-ui', 'cinderpaw-ui'],
  ['feral-model', 'cinderpaw-model'],
  ['feral-call-artifacts', 'cinderpaw-call-artifacts'],
  ['feral.onboarding', 'cinderpaw.onboarding'],
  ['feral.autoUpdateCheck', 'cinderpaw.autoUpdateCheck'],
  ['feral.agentByokDismissed', 'cinderpaw.agentByokDismissed'],
  ['feral.fractal.maturityFloor', 'cinderpaw.fractal.maturityFloor'],
  ['feral_active_agent_id', 'cinderpaw_active_agent_id'],
  ['feral_agents_onboarding', 'cinderpaw_agents_onboarding'],
];

/** Set once the migration has run, so it is not attempted on every start. */
const DONE_KEY = 'cinderpaw.storageMigrated';

export interface StorageMigrationResult {
  /** How many keys were carried across. Zero on a fresh install. */
  moved: number;
  /** True when the migration had already been done. */
  alreadyDone: boolean;
}

export function migrateLocalStorage(store: Storage = localStorage): StorageMigrationResult {
  try {
    if (store.getItem(DONE_KEY) !== null) return { moved: 0, alreadyDone: true };

    let moved = 0;
    for (const [from, to] of RENAMES) {
      const value = store.getItem(from);
      if (value === null) continue;
      // Never overwrite a value already under the new name: if both exist, the
      // new one is the one the app has been writing to.
      if (store.getItem(to) !== null) {
        // And in that case the old key STAYS. Removing it here is what turned a
        // skipped copy into a permanent loss: the destination can be non-empty
        // for a reason nobody wants — a store module that rehydrated and wrote
        // its defaults before this ran — and then the only real copy of
        // somebody's settings was deleted to tidy up. A few orphaned kilobytes
        // are cheaper than that, every time.
        continue;
      }
      store.setItem(to, value);
      moved += 1;
      store.removeItem(from);
    }

    store.setItem(DONE_KEY, new Date().toISOString());
    return { moved, alreadyDone: false };
  } catch {
    // Storage unavailable. The app starts with defaults, which is the same
    // thing that would happen without this function.
    return { moved: 0, alreadyDone: false };
  }
}
