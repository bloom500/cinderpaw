//! Brand constants — the single source of truth for user-facing names in Rust.
//!
//! Mirror of `frontend-react/src/lib/brand.ts` and `FeralAgent/src/brand.ts`.
//!
//! The technical identities below (bundle id, home directory) deliberately still
//! say `feral`: they are what an existing install is already using, and moving
//! them without a migrator beside them loses the user's data. They live here so
//! that the phase which does move them has one place to edit rather than five
//! hundred call sites.

/// What the app calls itself to a person.
pub const APP_NAME: &str = "Cinderpaw";
pub const APP_NAME_LOWER: &str = "cinderpaw";
pub const APP_DOMAIN: &str = "cinderpaw.ai";

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
