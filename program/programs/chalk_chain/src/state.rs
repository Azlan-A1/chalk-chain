use anchor_lang::prelude::*;

use crate::constants::MAX_LINKS;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    pub window_slots: u64,
    pub recheck_window_slots: u64,
    pub recheck_interval_slots: u64,
    pub bonus_per_link: u64,
    pub recheck_threshold: u8,
    pub max_links: u8,
    pub min_headcount: u8,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Teacher {
    pub wallet: Pubkey,
    pub school_id: u32,
    pub days_settled: u32,
    pub total_paid: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Link {
    pub slot: u64,
    pub photo_hash: [u8; 32],
    pub seed: [u8; 32],
    pub commit: [u8; 32],
    pub words: [u8; 3],
    pub flags: u8,
    pub headcount: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Day {
    pub teacher: Pubkey,
    pub day: u32,
    pub n_links: u8,
    pub recheck_pending: bool,
    pub rechecks_met: u8,
    pub missed_recheck: bool,
    pub settled: bool,
    pub bump: u8,
    pub recheck_from_slot: u64,
    pub recheck_deadline_slot: u64,
    pub last_rolled_boundary: u64,
    pub paid: u64,
    pub links: [Link; MAX_LINKS],
}

impl Day {
    pub fn last_link(&self) -> &Link {
        &self.links[(self.n_links as usize).saturating_sub(1)]
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigArgs {
    pub oracle: Pubkey,
    pub window_slots: u64,
    pub recheck_window_slots: u64,
    pub recheck_interval_slots: u64,
    pub bonus_per_link: u64,
    pub recheck_threshold: u8,
    pub max_links: u8,
    pub min_headcount: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_sizes_match_spec() {
        assert_eq!(8 + Config::INIT_SPACE, 141);
        assert_eq!(8 + Teacher::INIT_SPACE, 57);
        assert_eq!(Link::INIT_SPACE, 109);
        assert_eq!(8 + Day::INIT_SPACE, 736);
    }

    #[test]
    fn day_borsh_len_matches_init_space() {
        let day = Day {
            teacher: Pubkey::default(),
            day: 0,
            n_links: 0,
            recheck_pending: false,
            rechecks_met: 0,
            missed_recheck: false,
            settled: false,
            bump: 0,
            recheck_from_slot: 0,
            recheck_deadline_slot: 0,
            last_rolled_boundary: 0,
            paid: 0,
            links: [Link::default(); MAX_LINKS],
        };
        let mut buf = Vec::new();
        day.try_serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), 736);
        assert_eq!(&buf[..8], Day::DISCRIMINATOR);
    }
}
