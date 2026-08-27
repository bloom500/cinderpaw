/**
 * Brand constants — the single source of truth for user-facing names.
 *
 * The app was called Cinderpaw and is now Cinderpaw. The word should not appear
 * hardcoded in a component again: a name that lives in 291 string literals is a
 * name nobody can change, and this is the second time it has needed changing.
 * Anything a person reads comes from here.
 *
 * The config directory has since moved too — `crates/cinderpaw-core/src/
 * migrate_home.rs` carries `~/.feral` across to `~/.cinderpaw` on first launch —
 * so its name lives here as well, for the one place the UI has to show a path
 * before the backend has told it one.
 *
 * What is deliberately NOT here: the bundle identifier, the `CINDERPAW_*`
 * environment variables, the `feral://` event channel names and the CLI binary
 * name. Those are technical identities with migration cost, and they move in a
 * later phase with a migrator beside them. See RENAME-PLAN.md.
 */
export const APP_NAME = 'Cinderpaw' as const;
export const APP_NAME_LOWER = 'cinderpaw' as const;

/** What a brand-new agent is called before the user names it. */
export const AGENT_DEFAULT_NAME = APP_NAME;


/**
 * Home directory the app keeps everything in. Mirrors
 * `cinderpaw_core::brand::APP_HOME_DIR_NAME` — the two must not drift, or the
 * UI shows a path that does not exist.
 *
 * Only for display fallbacks: the real path always comes from the backend,
 * which honours `CINDERPAW_HOME` and portable installs. A hardcoded `~/.feral`
 * here outlived the migration and was still on the Settings screen.
 */
export const APP_HOME_DIR_NAME = '.cinderpaw' as const;

/** One line, for the welcome screen and the about panel. */
export const BRAND_TAGLINE = 'An AI companion that lives on your machine.';

/**
 * The old names, kept for migration lookups and for recognising data written by
 * a previous version — never for display.
 */
export const LEGACY_BRAND_NAMES = ['Cinderpaw', 'feral', 'FERAL'] as const;
