use anchor_lang::prelude::*;

#[event]
pub struct CheckedIn {
    pub teacher: Pubkey,
    pub day: u32,
    pub idx: u8,
    pub slot: u64,
    pub slot_age: u64,
    pub words: [u8; 3],
}

#[event]
pub struct RecheckStarted {
    pub teacher: Pubkey,
    pub day: u32,
    pub from_slot: u64,
    pub deadline_slot: u64,
}

#[event]
pub struct RecheckRolled {
    pub teacher: Pubkey,
    pub day: u32,
    pub boundary_slot: u64,
    pub roll: u8,
    pub hit: bool,
}

#[event]
pub struct Attested {
    pub teacher: Pubkey,
    pub day: u32,
    pub idx: u8,
    pub flags: u8,
    pub headcount: u8,
}

#[event]
pub struct Settled {
    pub teacher: Pubkey,
    pub day: u32,
    pub passing: u8,
    pub missed_recheck: bool,
    pub amount: u64,
}
