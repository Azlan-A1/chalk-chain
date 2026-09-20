use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const TEACHER_SEED: &[u8] = b"teacher";
#[constant]
pub const DAY_SEED: &[u8] = b"day";

pub const MAX_LINKS: usize = 6;

/// SlotHashes keeps this many entries. A challenge slot older than that cannot be looked up at
/// all, so a window beyond it would promise the teacher time the chain cannot honour. Devnet runs
/// near 166 ms per slot, where 512 slots is only ~85 s.
pub const SLOT_HASHES_CAPACITY: u64 = 512;
/// Leave headroom for skipped slots, which shorten the real span.
pub const MAX_WINDOW_SLOTS: u64 = 450;

pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

// Link flag bits (set by the oracle in `attest`).
#[constant]
pub const WORDS_OK: u8 = 1;
#[constant]
pub const CHAIN_OK: u8 = 2;
#[constant]
pub const NOT_RECAPTURE: u8 = 4;
#[constant]
pub const NOT_REUSED: u8 = 8;
#[constant]
pub const PEOPLE_OK: u8 = 16;
#[constant]
pub const ATTESTED: u8 = 128;
#[constant]
pub const PASS_MASK: u8 = 0b1001_1111;

pub const SECONDS_PER_DAY: i64 = 86_400;
