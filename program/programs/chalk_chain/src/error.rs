use anchor_lang::prelude::*;

// Order is part of the contract (SPEC §2.5): codes 6000..=6015.
#[error_code]
pub enum ChalkError {
    #[msg("Those words expired. Get new ones.")]
    SlotNotFound,
    #[msg("Photo sent too late. Get new words and try again.")]
    SlotTooOld,
    #[msg("These words are older than your last photo.")]
    SlotNotIncreasing,
    #[msg("Use the new words from this re-check.")]
    SlotBeforeRecheck,
    #[msg("Your phone's date looks wrong.")]
    DayMismatch,
    #[msg("Today's chain is full.")]
    TooManyLinks,
    #[msg("No re-check is open right now.")]
    NoRecheckPending,
    #[msg("The re-check window closed.")]
    RecheckExpired,
    #[msg("A re-check is still open.")]
    RecheckInProgress,
    #[msg("Only the verifier can do that.")]
    NotOracle,
    #[msg("Today is already settled.")]
    AlreadySettled,
    #[msg("That photo doesn't exist.")]
    BadLinkIndex,
    #[msg("Not a re-check boundary slot.")]
    NotABoundary,
    #[msg("That boundary was already rolled.")]
    AlreadyRolled,
    #[msg("Boundary slot out of range.")]
    BadBoundary,
    #[msg("Invalid configuration.")]
    InvalidConfig,
}
