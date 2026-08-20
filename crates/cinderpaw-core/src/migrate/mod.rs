//! Importing another agent's setup into Cinderpaw.
//!
//! Read-only on the source, always. The design point is in `ledger`: their
//! formats move and we do not control them, so this module is built to be
//! honest about what it did not understand rather than to claim coverage it
//! cannot keep.

pub mod detect;
pub mod ledger;
pub mod persona;
pub mod source;

pub use detect::{detect, Found, Source};
pub use ledger::KeyLedger;
pub use persona::{apply_persona, plan_persona, Plan, PlanItem};
pub use source::{read_source, SourceData};
