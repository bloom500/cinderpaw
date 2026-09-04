/**
 * Brand constants for the sidecar — mirror of `frontend-react/src/lib/brand.ts`.
 *
 * Two copies rather than one shared module because the two live on opposite
 * sides of a process boundary and are bundled separately. If they drift, the
 * symptom is the agent introducing itself by one name while the window says
 * another.
 */
export const APP_NAME = "Cinderpaw";
export const APP_NAME_LOWER = "cinderpaw";

/**
 * Home directory names.
 *
 * The move HAS happened — the Rust host migrates `~/.feral` to `~/.cinderpaw`
 * on the first start after the rename. This half was left behind, and a
 * half-done rename is worse than none: the host wrote conversations, keys and
 * models to the new home while the sidecar kept writing RSI state, governance
 * and safety snapshots to the old one, so a person's data lived in two places
 * at once. Worse, re-creating `~/.feral` after the host had migrated made the
 * migration guard see an unmarked legacy home on the NEXT boot and refuse to
 * start at all — the app bricked itself on second launch.
 *
 * `LEGACY_HOME_DIR_NAME` stays readable for as long as machines that predate
 * the rename exist: a sidecar-only install (headless, TUI) never runs the
 * host's migrator, so its data is still sitting under the old name.
 */
export const APP_HOME_DIR_NAME = ".cinderpaw";
export const LEGACY_HOME_DIR_NAME = ".feral";
