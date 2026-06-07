//! Forward derivation of infrastructure storage slots (DESIGN.md §5.4).
//!
//! These are the non-channel/note slots the contract and its components write:
//! the four singletons and the component substorage variables. Marking them
//! shrinks the anomaly set to genuinely-unexplained slots. This is noise
//! reduction, not a security guarantee — version drift can only leave extra
//! slots unexplained (an anomaly to triage), never hide one, since marking only
//! ever *adds* to the explained set.
//!
//! Slot layout, authoritative once the §4.4 class-hash check passes:
//! - **Singletons** (4): `auditor_public_key`, `fee_amount`, `fee_collector`,
//!   `proof_validity_blocks` — top-level vars in `privacy.cairo`.
//! - **Components** (`#[substorage(v0)]`): each component storage var is addressed
//!   by its own name, so its slot is `get_storage_var_address(var_name, keys)`.
//!   - `pausable` → `starkware_utils` (`paused`)
//!   - `replaceability` → `starkware_utils` (`initialized`, `upgrade_delay`,
//!     `finalized`; the `impl_*_time` maps are keyed by impl hash — see below)
//!   - `reentrancy_guard` → OpenZeppelin 3.0.0 (`ReentrancyGuard_entered`)
//!
//! **Keyed component slots are intentionally not derived here** — they need
//! dynamic keys this offline pass does not have: `access_control` members/admins
//! (role ids + grantee addresses), `src5` supported interfaces (interface ids),
//! and the `replaceability` `impl_*_time` maps (impl hashes). DESIGN §5.4 ties
//! those to constants and the FETCH role-event scan; until that lands they remain
//! anomalies (safe — omission can only over-report).

use starknet_core::utils::get_storage_var_address;

use crate::owned_slots::OwnedSlot;

/// `(storage var name, slot kind)` for every statically-derivable infra slot.
/// Names are the exact Cairo storage identifiers; kinds follow DESIGN §4.3
/// (`singleton:<name>` / `component:<component>:<var>`).
const STATIC_INFRA_SLOTS: &[(&str, &str)] = &[
    ("auditor_public_key", "singleton:auditor_public_key"),
    ("fee_amount", "singleton:fee_amount"),
    ("fee_collector", "singleton:fee_collector"),
    ("proof_validity_blocks", "singleton:proof_validity_blocks"),
    ("paused", "component:pausable:paused"),
    ("initialized", "component:replaceability:initialized"),
    ("upgrade_delay", "component:replaceability:upgrade_delay"),
    ("finalized", "component:replaceability:finalized"),
    (
        "ReentrancyGuard_entered",
        "component:reentrancy_guard:ReentrancyGuard_entered",
    ),
];

/// Derives every statically-addressable infrastructure slot and tags it with its
/// `kind`. These have no dynamic keys, so each resolves to a single fixed slot.
///
/// `analyze` marks these alongside the per-user owned slots; whichever a given
/// snapshot actually wrote get classified, the rest are simply absent.
pub fn static_infra_slots() -> Vec<OwnedSlot> {
    STATIC_INFRA_SLOTS
        .iter()
        .map(|(name, kind)| OwnedSlot {
            // Names are compile-time literals well under the 31-char limit, so
            // address derivation cannot fail here.
            slot: get_storage_var_address(name, &[]).expect("storage var name exceeds 31 chars"),
            kind,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use discovery_core::privacy_pool::storage_slots;
    use starknet_types_core::felt::Felt;

    use super::*;

    #[test]
    fn test_singleton_address_matches_discovery_core() {
        // Cross-check our derivation against discovery-core's known selector.
        let slots = static_infra_slots();
        let auditor = slots
            .iter()
            .find(|s| s.kind == "singleton:auditor_public_key")
            .unwrap();
        assert_eq!(auditor.slot, storage_slots::auditor_public_key());
    }

    #[test]
    fn test_all_static_slots_present_and_distinct() {
        let slots = static_infra_slots();
        assert_eq!(slots.len(), STATIC_INFRA_SLOTS.len());

        // Every entry resolves to a distinct, non-zero slot.
        let mut addresses: Vec<Felt> = slots.iter().map(|s| s.slot).collect();
        assert!(addresses.iter().all(|&a| a != Felt::ZERO));
        addresses.sort();
        addresses.dedup();
        assert_eq!(addresses.len(), STATIC_INFRA_SLOTS.len());
    }

    #[test]
    fn test_kinds_follow_design_namespacing() {
        for slot in static_infra_slots() {
            assert!(
                slot.kind.starts_with("singleton:") || slot.kind.starts_with("component:"),
                "unexpected kind: {}",
                slot.kind
            );
        }
    }
}
