use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const TEACHER_SEED: &[u8] = b"teacher";
#[constant]
pub const DAY_SEED: &[u8] = b"day";

#[constant]
pub const MAX_LINKS: usize = 6;

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
