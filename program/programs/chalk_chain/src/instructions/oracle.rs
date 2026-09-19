use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    derive as chain,
    error::ChalkError,
    events::{Attested, RecheckRolled, RecheckStarted, Settled},
    state::*,
};

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct TriggerRecheck<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = oracle @ ChalkError::NotOracle)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: teacher wallet; only used as a PDA seed.
    pub teacher: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [DAY_SEED, teacher.key().as_ref(), day.to_le_bytes().as_ref()],
        bump = day_account.bump
    )]
    pub day_account: Box<Account<'info, Day>>,
}

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct RollRecheck<'info> {
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: teacher wallet; only used as a PDA seed.
    pub teacher: UncheckedAccount<'info>,
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

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct Attest<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = oracle @ ChalkError::NotOracle)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: teacher wallet; only used as a PDA seed.
    pub teacher: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [DAY_SEED, teacher.key().as_ref(), day.to_le_bytes().as_ref()],
        bump = day_account.bump
    )]
    pub day_account: Box<Account<'info, Day>>,
}

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct SettleDay<'info> {
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle @ ChalkError::NotOracle,
        has_one = usdc_mint,
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: teacher wallet; PDA seed and ATA owner.
    pub teacher: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [TEACHER_SEED, teacher.key().as_ref()],
        bump = teacher_account.bump
    )]
    pub teacher_account: Box<Account<'info, Teacher>>,
    #[account(
        mut,
        seeds = [DAY_SEED, teacher.key().as_ref(), day.to_le_bytes().as_ref()],
        bump = day_account.bump
    )]
    pub day_account: Box<Account<'info, Day>>,
    /// CHECK: PDA that owns the vault token account; holds no data.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = teacher,
        associated_token::token_program = token_program,
    )]
    pub teacher_usdc: Box<Account<'info, TokenAccount>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// A re-check can only start on an open day whose chain can still grow;
/// otherwise the teacher could never answer it and would lose the whole day.
fn can_start_recheck(d: &Day, cfg: &Config) -> Result<()> {
    require!(!d.settled, ChalkError::AlreadySettled);
    require!(d.n_links >= 1, ChalkError::BadLinkIndex);
    require!(!d.recheck_pending, ChalkError::RecheckInProgress);
    require!(
        (d.n_links as usize) < (cfg.max_links as usize).min(MAX_LINKS),
        ChalkError::TooManyLinks
    );
    Ok(())
}

fn start_recheck(d: &mut Day, from_slot: u64, window: u64) {
    d.recheck_pending = true;
    d.recheck_from_slot = from_slot;
    d.recheck_deadline_slot = from_slot.saturating_add(window);
    emit!(RecheckStarted {
        teacher: d.teacher,
        day: d.day,
        from_slot: d.recheck_from_slot,
        deadline_slot: d.recheck_deadline_slot,
    });
}

pub fn handle_trigger_recheck(ctx: Context<TriggerRecheck>, _day: u32) -> Result<()> {
    let now = Clock::get()?.slot;
    let cfg = &ctx.accounts.config;
    let d = &mut ctx.accounts.day_account;
    can_start_recheck(d, cfg)?;
    start_recheck(d, now, cfg.recheck_window_slots);
    Ok(())
}

pub fn handle_roll_recheck(ctx: Context<RollRecheck>, _day: u32, boundary_slot: u64) -> Result<()> {
    let now = Clock::get()?.slot;
    let cfg = &ctx.accounts.config;
    let day_key = ctx.accounts.day_account.key();
    let d = &mut ctx.accounts.day_account;

    require!(!d.settled, ChalkError::AlreadySettled);
    require!(d.n_links >= 1, ChalkError::BadLinkIndex);
    require!(!d.recheck_pending, ChalkError::RecheckInProgress);
    require!(
        cfg.recheck_interval_slots > 0 && boundary_slot % cfg.recheck_interval_slots == 0,
        ChalkError::NotABoundary
    );
    require!(boundary_slot > d.last_rolled_boundary, ChalkError::AlreadyRolled);
    require!(
        boundary_slot > d.last_link().slot && boundary_slot <= now,
        ChalkError::BadBoundary
    );
    // Only a boundary from the current interval may be rolled. Otherwise anyone could roll a slot
    // from long ago: the re-check would open with a deadline already in the past, the teacher could
    // never answer it, and settle_day would pay nothing.
    require!(
        now.saturating_sub(boundary_slot) <= cfg.recheck_interval_slots,
        ChalkError::BadBoundary
    );
    let h = {
        let data = ctx.accounts.slot_hashes.try_borrow_data()?;
        chain::find_slot_hash(&data, boundary_slot).ok_or_else(|| error!(ChalkError::SlotNotFound))?
    };
    d.last_rolled_boundary = boundary_slot;

    let roll = chain::roll_byte(&h, &day_key.to_bytes());
    let room = (d.n_links as usize) < (cfg.max_links as usize).min(MAX_LINKS);
    let hit = roll < cfg.recheck_threshold && room;
    if hit {
        start_recheck(d, boundary_slot, cfg.recheck_window_slots);
    }
    emit!(RecheckRolled {
        teacher: d.teacher,
        day: d.day,
        boundary_slot,
        roll,
        hit,
    });
    Ok(())
}

pub fn handle_attest(
    ctx: Context<Attest>,
    _day: u32,
    idx: u8,
    flags: u8,
    headcount: u8,
) -> Result<()> {
    let d = &mut ctx.accounts.day_account;
    require!(!d.settled, ChalkError::AlreadySettled);
    require!(idx < d.n_links, ChalkError::BadLinkIndex);
    let stored = flags | ATTESTED;
    d.links[idx as usize].flags = stored;
    d.links[idx as usize].headcount = headcount;
    emit!(Attested {
        teacher: d.teacher,
        day: d.day,
        idx,
        flags: stored,
        headcount,
    });
    Ok(())
}

pub fn handle_settle_day(ctx: Context<SettleDay>, _day: u32) -> Result<()> {
    let now = Clock::get()?.slot;
    let cfg = &ctx.accounts.config;
    let d = &mut ctx.accounts.day_account;
    require!(!d.settled, ChalkError::AlreadySettled);

    if d.recheck_pending {
        require!(now > d.recheck_deadline_slot, ChalkError::RecheckInProgress);
        d.missed_recheck = true;
        d.recheck_pending = false;
    }

    let n = d.n_links as usize;
    let passing = d.links[..n].iter().filter(|l| chain::link_passes(l.flags)).count() as u8;
    let first_ok = n >= 1 && chain::link_passes(d.links[0].flags);
    let amount = if first_ok && !d.missed_recheck {
        (passing as u64)
            .checked_mul(cfg.bonus_per_link)
            .ok_or_else(|| error!(ChalkError::InvalidConfig))?
    } else {
        0
    };

    if amount > 0 {
        let seeds: &[&[u8]] = &[VAULT_SEED, &[cfg.vault_bump]];
        let signer = &[seeds];
        let cpi = CpiContext::new_with_signer(
            Token::id(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.teacher_usdc.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer,
        );
        transfer_checked(cpi, amount, ctx.accounts.usdc_mint.decimals)?;
    }

    d.settled = true;
    d.paid = amount;
    let t = &mut ctx.accounts.teacher_account;
    t.days_settled = t.days_settled.saturating_add(1);
    t.total_paid = t.total_paid.saturating_add(amount);

    emit!(Settled {
        teacher: d.teacher,
        day: d.day,
        passing,
        missed_recheck: d.missed_recheck,
        amount,
    });
    Ok(())
}
