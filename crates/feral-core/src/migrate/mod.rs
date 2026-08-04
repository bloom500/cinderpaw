//! Importing another agent's setup into Feral.
//!
//! Read-only on the source, always. The design point is in `ledger`: their
//! formats move and we do not control them, so this module is built to be
//! honest about what it did not understand rather than to claim coverage it
//! cannot keep.

pub mod detect;
pub mod source;

pub use detect::{detect, Found, Source};
pub use source::{read_source, SourceData};
