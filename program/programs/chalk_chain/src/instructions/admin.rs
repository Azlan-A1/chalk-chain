use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{constants::*, error::ChalkError, state::*};

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: PDA that owns the vault token account; holds no data.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct RegisterTeacher<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub teacher: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Teacher::INIT_SPACE,
        seeds = [TEACHER_SEED, teacher.key().as_ref()],
        bump
    )]
    pub teacher_account: Box<Account<'info, Teacher>>,
    pub system_program: Program<'info, System>,
}

fn apply_args(cfg: &mut Config, args: &ConfigArgs) -> Result<()> {
    require!(
        args.max_links >= 1
            && args.max_links as usize <= MAX_LINKS
            && args.window_slots > 0
            && args.window_slots <= MAX_WINDOW_SLOTS
            && args.recheck_window_slots > 0
            && args.recheck_interval_slots > 0,
        ChalkError::InvalidConfig
    );
    cfg.oracle = args.oracle;
    cfg.window_slots = args.window_slots;
    cfg.recheck_window_slots = args.recheck_window_slots;
    cfg.recheck_interval_slots = args.recheck_interval_slots;
    cfg.bonus_per_link = args.bonus_per_link;
    cfg.recheck_threshold = args.recheck_threshold;
    cfg.max_links = args.max_links;
    cfg.min_headcount = args.min_headcount;
    Ok(())
}

pub fn handle_init_config(ctx: Context<InitConfig>, args: ConfigArgs) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.admin = ctx.accounts.admin.key();
    cfg.usdc_mint = ctx.accounts.usdc_mint.key();
    cfg.bump = ctx.bumps.config;
    cfg.vault_bump = ctx.bumps.vault_authority;
    apply_args(cfg, &args)
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: ConfigArgs) -> Result<()> {
    apply_args(&mut ctx.accounts.config, &args)
}

pub fn handle_register_teacher(ctx: Context<RegisterTeacher>, school_id: u32) -> Result<()> {
    let t = &mut ctx.accounts.teacher_account;
    t.wallet = ctx.accounts.teacher.key();
    t.school_id = school_id;
    t.days_settled = 0;
    t.total_paid = 0;
    t.bump = ctx.bumps.teacher_account;
    Ok(())
}
