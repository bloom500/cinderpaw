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
 * Home directory names. The app still reads and writes `.feral` — the move is a
 * later phase, with a migrator. These constants exist so that when it happens
 * there is one place to change, not a search across the tree.
 */
export const APP_HOME_DIR_NAME = ".feral";
export const FUTURE_HOME_DIR_NAME = ".cinderpaw";
export const LEGACY_HOME_DIR_NAME = ".feral";
