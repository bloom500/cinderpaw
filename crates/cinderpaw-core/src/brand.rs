//! Brand constants — the single source of truth for user-facing names in Rust.
//!
//! Mirror of `frontend-react/src/lib/brand.ts` and `CinderpawAgent/src/brand.ts`.
//!
//! The technical identities below (bundle id, home directory) have now moved
//! too. Nothing here is safe to edit on its own: the home directory is carried
//! across by `crate::migrate_home`, and the bundle identifier travels with it,
//! because an app whose data moved but whose identity did not is an app with
//! two half-installs. `LEGACY_HOME_DIR_NAME` stays for as long as machines that
//! predate the rename exist.

/// What the app calls itself to a person.
pub const APP_NAME: &str = "Cinderpaw";
pub const APP_NAME_LOWER: &str = "cinderpaw";

/// Config directory under the home directory. Moved in this release; the
/// one-shot copy lives in `crate::migrate_home` and runs before anything reads
/// this path.
pub const APP_HOME_DIR_NAME: &str = ".cinderpaw";
pub const LEGACY_HOME_DIR_NAME: &str = ".feral";

/// Bundle identifier. Moved together with the home directory, because the two
/// are the same decision: the OS treats a changed identifier as a different
/// application, and an app whose data moved but whose identity did not (or the
/// reverse) is an app with two half-installs.
pub const APP_IDENTIFIER: &str = "ai.cinderpaw.app";
