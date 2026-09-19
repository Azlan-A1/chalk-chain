//! Pure word derivation (SPEC §1) and SlotHashes lookup (SPEC §2.4).
//! No account access here, so everything is unit-testable on the host.

use solana_sha256_hasher::hashv;

use crate::constants::PASS_MASK;

pub const DOMAIN: &[u8] = b"chalk-chain";

/// Size of one SlotHashes entry: u64 slot + 32-byte hash.
const ENTRY_LEN: usize = 40;

pub fn prev0(teacher: &[u8; 32], day: u32) -> [u8; 32] {
    hashv(&[DOMAIN, teacher, &day.to_le_bytes()]).to_bytes()
}

pub fn seed(slot_hash: &[u8; 32], teacher: &[u8; 32], prev: &[u8; 32]) -> [u8; 32] {
    hashv(&[slot_hash, teacher, prev]).to_bytes()
}

pub fn word_indices(seed: &[u8; 32]) -> [u8; 3] {
    [seed[0], seed[1], seed[2]]
}

pub fn commit(photo_hash: &[u8; 32], seed: &[u8; 32]) -> [u8; 32] {
    hashv(&[photo_hash, seed]).to_bytes()
}

/// First byte of sha256(boundary_hash ‖ day_account_address).
pub fn roll_byte(boundary_hash: &[u8; 32], day_account: &[u8; 32]) -> u8 {
    hashv(&[boundary_hash, day_account]).to_bytes()[0]
}

pub fn link_passes(flags: u8) -> bool {
    flags & PASS_MASK == PASS_MASK
}

/// Binary-search raw SlotHashes sysvar data (`u64 len`, then `len` entries of
/// `(u64 slot, [u8; 32] hash)`, newest first, i.e. slots strictly descending).
pub fn find_slot_hash(data: &[u8], slot: u64) -> Option<[u8; 32]> {
    let len_bytes: [u8; 8] = data.get(0..8)?.try_into().ok()?;
    let declared = u64::from_le_bytes(len_bytes) as usize;
    let len = declared.min((data.len() - 8) / ENTRY_LEN);

    let (mut lo, mut hi) = (0usize, len);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let off = 8 + mid * ENTRY_LEN;
        let s = u64::from_le_bytes(data[off..off + 8].try_into().ok()?);
        if s == slot {
            return data[off + 8..off + ENTRY_LEN].try_into().ok();
        }
        if s > slot {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(s: &str) -> [u8; 32] {
        assert_eq!(s.len(), 64);
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn reproduces_shared_vectors() {
        let raw = include_str!("../../../../shared/vectors/derivation.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(v["domain"].as_str().unwrap().as_bytes(), DOMAIN);
        let cases = v["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        let mut links_checked = 0;
        for case in cases {
            let teacher = hex32(case["teacher"].as_str().unwrap());
            let day = case["day"].as_u64().unwrap() as u32;
            let p0 = prev0(&teacher, day);
            assert_eq!(p0, hex32(case["prev0"].as_str().unwrap()));

            let mut prev = p0;
            for link in case["links"].as_array().unwrap() {
                assert_eq!(prev, hex32(link["prev"].as_str().unwrap()));
                let sh = hex32(link["slot_hash"].as_str().unwrap());
                let ph = hex32(link["photo_hash"].as_str().unwrap());
                let s = seed(&sh, &teacher, &prev);
                assert_eq!(s, hex32(link["seed"].as_str().unwrap()));
                let words: Vec<u8> = link["words"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|w| w.as_u64().unwrap() as u8)
                    .collect();
                assert_eq!(word_indices(&s).to_vec(), words);
                let c = commit(&ph, &s);
                assert_eq!(c, hex32(link["commit"].as_str().unwrap()));
                prev = c;
                links_checked += 1;
            }
        }
        assert_eq!(links_checked, 9);
    }

    /// Build SlotHashes account data for the given (slot, hash) entries (newest first).
    fn slot_hashes_data(entries: &[(u64, [u8; 32])], pad_to: usize) -> Vec<u8> {
        let mut d = (entries.len() as u64).to_le_bytes().to_vec();
        for (s, h) in entries {
            d.extend_from_slice(&s.to_le_bytes());
            d.extend_from_slice(h);
        }
        d.resize(d.len().max(pad_to), 0);
        d
    }

    #[test]
    fn slot_hash_search() {
        let entries: Vec<(u64, [u8; 32])> = (0..512u64)
            .map(|i| {
                let slot = 10_000 - i * 2; // descending, with gaps (skipped slots)
                let mut h = [0u8; 32];
                h[..8].copy_from_slice(&slot.to_le_bytes());
                (slot, h)
            })
            .collect();
        let data = slot_hashes_data(&entries, 20_488);
        for (slot, h) in &entries {
            assert_eq!(find_slot_hash(&data, *slot), Some(*h), "slot {slot}");
        }
        assert_eq!(find_slot_hash(&data, 10_001), None); // newer than newest
        assert_eq!(find_slot_hash(&data, 9_999), None); // skipped slot
        assert_eq!(find_slot_hash(&data, 10_000 - 1022 - 2), None); // older than oldest
        assert_eq!(find_slot_hash(&data, 0), None);
    }

    #[test]
    fn slot_hash_search_edge_cases() {
        assert_eq!(find_slot_hash(&[], 1), None);
        assert_eq!(find_slot_hash(&[0u8; 7], 1), None);
        assert_eq!(find_slot_hash(&slot_hashes_data(&[], 0), 1), None);
        let one = slot_hashes_data(&[(5, [7u8; 32])], 0);
        assert_eq!(find_slot_hash(&one, 5), Some([7u8; 32]));
        assert_eq!(find_slot_hash(&one, 4), None);
        // Declared length larger than the data must not read out of bounds.
        let mut lying = one.clone();
        lying[0..8].copy_from_slice(&100u64.to_le_bytes());
        assert_eq!(find_slot_hash(&lying, 5), Some([7u8; 32]));
        assert_eq!(find_slot_hash(&lying, 3), None);
    }

    #[test]
    fn pass_mask() {
        assert!(link_passes(0b1001_1111));
        assert!(link_passes(0xff));
        assert!(!link_passes(0b0001_1111)); // not attested
        assert!(!link_passes(0b1000_1111)); // no people
        assert!(!link_passes(0));
    }
}
