use anchor_lang::prelude::*;

use crate::{constants::*, derive, error::ChalkError, events::CheckedIn, state::*};

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct CheckIn<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub teacher: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [TEACHER_SEED, teacher.key().as_ref()], bump = teacher_account.bump)]
    pub teacher_account: Box<Account<'info, Teacher>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Day::INIT_SPACE,
        seeds = [DAY_SEED, teacher.key().as_ref(), day.to_le_bytes().as_ref()],
        bump
    )]
    pub day_account: Box<Account<'info, Day>>,
    /// CHECK: pinned to the SlotHashes sysvar address; parsed raw.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct RecheckIn<'info> {
    pub teacher: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [DAY_SEED, teacher.key().as_ref(), day.to_le_bytes().as_ref()],
        bump = day_account.bump
    )]
    pub day_account: Box<Account<'info, Day>>,
    /// CHECK: pinned to the SlotHashes sysvar address; parsed raw.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// Freshness check, then look the slot up in SlotHashes.
pub(crate) fn fresh_slot_hash(
    slot_hashes: &AccountInfo,
    slot: u64,
    now: u64,
    window_slots: u64,
) -> Result<[u8; 32]> {
    require!(now.saturating_sub(slot) <= window_slots, ChalkError::SlotTooOld);
    let data = slot_hashes.try_borrow_data()?;
    derive::find_slot_hash(&data, slot).ok_or_else(|| error!(ChalkError::SlotNotFound))
}

/// Derive and store the next link, then emit `CheckedIn`.
fn append_link(
    d: &mut Day,
    teacher: &Pubkey,
    prev: &[u8; 32],
    slot: u64,
    slot_hash: &[u8; 32],
    photo_hash: [u8; 32],
    now: u64,
) {
    let seed = derive::seed(slot_hash, &teacher.to_bytes(), prev);
    let words = derive::word_indices(&seed);
    let idx = d.n_links;
    d.links[idx as usize] = Link {
        slot,
        photo_hash,
        seed,
        commit: derive::commit(&photo_hash, &seed),
        words,
        flags: 0,
        headcount: 0,
    };
    d.n_links = idx + 1;
    emit!(CheckedIn {
        teacher: *teacher,
        day: d.day,
        idx,
        slot,
        slot_age: now.saturating_sub(slot),
        words,
    });
}

pub fn handle_check_in(
    ctx: Context<CheckIn>,
    day: u32,
    slot: u64,
    photo_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.slot;
    let clock_day = clock.unix_timestamp.div_euclid(SECONDS_PER_DAY);
    let d64 = day as i64;
    require!(d64 == clock_day || d64 + 1 == clock_day, ChalkError::DayMismatch);

    let slot_hash = fresh_slot_hash(
        &ctx.accounts.slot_hashes,
        slot,
        now,
        ctx.accounts.config.window_slots,
    )?;

    let teacher = ctx.accounts.teacher.key();
    let d = &mut ctx.accounts.day_account;
    d.teacher = teacher;
    d.day = day;
    d.bump = ctx.bumps.day_account;
    let prev = derive::prev0(&teacher.to_bytes(), day);
    append_link(d, &teacher, &prev, slot, &slot_hash, photo_hash, now);
    Ok(())
}

pub fn handle_recheck_in(
    ctx: Context<RecheckIn>,
    _day: u32,
    slot: u64,
    photo_hash: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.slot;
    let cfg = &ctx.accounts.config;
    let d = &mut ctx.accounts.day_account;

    require!(d.recheck_pending, ChalkError::NoRecheckPending);
    require!(now <= d.recheck_deadline_slot, ChalkError::RecheckExpired);
    require!(slot >= d.recheck_from_slot, ChalkError::SlotBeforeRecheck);
    require!(slot > d.last_link().slot, ChalkError::SlotNotIncreasing);
    let slot_hash = fresh_slot_hash(&ctx.accounts.slot_hashes, slot, now, cfg.window_slots)?;
    require!(
        (d.n_links as usize) < (cfg.max_links as usize).min(MAX_LINKS),
        ChalkError::TooManyLinks
    );

    let teacher = ctx.accounts.teacher.key();
    let prev = d.last_link().commit;
    append_link(d, &teacher, &prev, slot, &slot_hash, photo_hash, now);
    d.recheck_pending = false;
    d.rechecks_met = d.rechecks_met.saturating_add(1);
    Ok(())
}
