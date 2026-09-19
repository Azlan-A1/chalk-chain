pub mod constants;
pub mod derive;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("5QfoP2K5HQWgmwA4YVNW8uMTccx4XHd3uFk7Ajg2xUJG");

#[program]
pub mod chalk_chain {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, args: ConfigArgs) -> Result<()> {
        instructions::admin::handle_init_config(ctx, args)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: ConfigArgs) -> Result<()> {
        instructions::admin::handle_update_config(ctx, args)
    }

    pub fn register_teacher(ctx: Context<RegisterTeacher>, school_id: u32) -> Result<()> {
        instructions::admin::handle_register_teacher(ctx, school_id)
    }

    pub fn check_in(ctx: Context<CheckIn>, day: u32, slot: u64, photo_hash: [u8; 32]) -> Result<()> {
        instructions::check_in::handle_check_in(ctx, day, slot, photo_hash)
    }

    pub fn recheck_in(
        ctx: Context<RecheckIn>,
        day: u32,
        slot: u64,
        photo_hash: [u8; 32],
    ) -> Result<()> {
        instructions::check_in::handle_recheck_in(ctx, day, slot, photo_hash)
    }

    pub fn trigger_recheck(ctx: Context<TriggerRecheck>, day: u32) -> Result<()> {
        instructions::oracle::handle_trigger_recheck(ctx, day)
    }

    pub fn roll_recheck(ctx: Context<RollRecheck>, day: u32, boundary_slot: u64) -> Result<()> {
        instructions::oracle::handle_roll_recheck(ctx, day, boundary_slot)
    }

    pub fn attest(ctx: Context<Attest>, day: u32, idx: u8, flags: u8, headcount: u8) -> Result<()> {
        instructions::oracle::handle_attest(ctx, day, idx, flags, headcount)
    }

    pub fn settle_day(ctx: Context<SettleDay>, day: u32) -> Result<()> {
        instructions::oracle::handle_settle_day(ctx, day)
    }
}
