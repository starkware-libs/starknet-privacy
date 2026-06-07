//! Forward derivation of infrastructure storage slots (DESIGN.md §5.4).
//!
//! These are the non-channel/note slots the contract and its components write:
//! the four singletons and the component substorage variables. Marking them
//! shrinks the anomaly set to genuinely-unexplained slots. This is noise
//! reduction, not a security guarantee — version drift can only leave extra
//! slots unexplained (an anomaly to triage), never hide one, since marking only
//! ever *adds* to the explained set.
//!
//! Slot layout is taken from the pinned sources (§4.4, trusted not verified).
//! Component storage vars use `#[substorage(v0)]`, so each is addressed by its
//! own name: `get_storage_var_address(var_name, keys)`.
//!
//! Derived here:
//! - **Singletons** (4): `auditor_public_key`, `fee_amount`, `fee_collector`,
//!   `proof_validity_blocks` — top-level vars in `privacy.cairo`.
//! - **No-key component vars:** `pausable::paused`; `replaceability::{initialized,
//!   upgrade_delay, finalized}`; `reentrancy_guard::ReentrancyGuard_entered`;
//!   `roles::legacy_role_reclaim_disabled`.
//! - **`access_control::AccessControl_role_admin[role]`** for each role id in
//!   `RolesComponent`'s `ROLE_ADMIN_PAIRS` (10 roles), set on deploy.
//! - **`src5::SRC5_supported_interfaces[id]`** for the registered interface ids.
//!
//! Still deferred: **`AccessControl_role_member[(role, grantee)]`** — keyed by
//! grantee address, which comes from FETCH's `RoleGranted` scan (DESIGN §5.4).
//! Also not derived: `replaceability::impl_*_time` (keyed by impl hash, only
//! written on a pending upgrade). Omitting either only over-reports (safe).

use starknet_core::utils::get_storage_var_address;
use starknet_types_core::felt::Felt;

use crate::owned_slots::OwnedSlot;

/// `(storage var name, slot kind)` for every no-key infra slot — the four
/// singletons and the components' static (non-map) storage vars. Names are the
/// exact Cairo storage identifiers; kinds follow DESIGN §4.3.
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
    (
        "legacy_role_reclaim_disabled",
        "component:roles:legacy_role_reclaim_disabled",
    ),
];

/// The role ids `RolesComponent` sets an admin for (`ROLE_ADMIN_PAIRS`, pinned
/// `starkware_utils` rev `0e12df09`). Each produces an `AccessControl_role_admin`
/// entry on deploy. Role ids are `keccak("ROLE_<NAME>") & MASK_250` — stable
/// constants, so they hold regardless of the deployed rev (drift only over-reports).
pub(crate) const ROLE_IDS: &[&str] = &[
    "0xd2ead78c620e94b02d0a996e99298c59ddccfa1d8a0149080ac3a20de06068", // APP_GOVERNOR
    "0x3e615638e0b79444a70f8c695bf8f2a47033bf1cf95691ec3130f64939cee99", // APP_ROLE_ADMIN
    "0x3711c9d994faf6055172091cb841fd4831aa743e6f3315163b06a122c841846", // GOVERNANCE_ADMIN
    "0x023edb77f7c8cc9e38e8afe78954f703aeeda7fffe014eeb6e56ea84e62f6da7", // OPERATOR
    "0x0128d63adbf6b09002c26caf55c47e2f26635807e3ef1b027218aa74c8d61a3e", // TOKEN_ADMIN
    "0x1d8034a6db21585e9d97ca912eb8113361e6858f64c45c9b321a4d01e949484", // UPGRADE_AGENT
    "0x251e864ca2a080f55bce5da2452e8cfcafdbc951a3e7fff5023d558452ec228", // UPGRADE_GOVERNOR
    "0x26bd110619d11cfdfc28e281df893bc24828e89177318e9dbd860cdaedeb6b3", // SECURITY_ADMIN
    "0x37693ba312785932d430dccf0f56ffedd0aa7c0f8b6da2cc4530c2717689b96", // SECURITY_AGENT
    "0xa5a83e9807e87f281d865ab54b7b0ed2f7f4bbfef73888810ca16e95e734eb", // SECURITY_GOVERNOR
];

/// Interface ids the components register in SRC5 on deploy (`AccessControl`
/// registers `IACCESSCONTROL`; `ISRC5` included defensively — a no-op if absent).
const INTERFACE_IDS: &[&str] = &[
    "0x3f918d17e5ee77373b56385708f855659a07f75997f365cf87748628532a055", // ISRC5
    "0x23700be02858dbe2ac4dc9c9f66d0b6b0ed81ec7f970ca6844500a56ff61751", // IACCESSCONTROL
];

fn slot(name: &str, keys: &[Felt]) -> Felt {
    // All names are compile-time literals under the 31-char limit; keys are
    // constants — derivation cannot fail in practice.
    get_storage_var_address(name, keys).expect("storage var name exceeds 31 chars")
}

/// Derives every infrastructure slot whose address is known without runtime data:
/// the no-key singletons/component vars, the per-role `AccessControl_role_admin`
/// entries, and the SRC5 supported-interface flags (DESIGN §5.4). Slots a given
/// snapshot did not write are simply absent; `analyze` marks the rest.
///
/// `AccessControl_role_member` is **not** here — it is keyed by grantee address,
/// which comes from FETCH's `RoleGranted` scan (see `grantee_role_member_slots`).
pub fn derivable_infra_slots() -> Vec<OwnedSlot> {
    let mut slots: Vec<OwnedSlot> = STATIC_INFRA_SLOTS
        .iter()
        .map(|(name, kind)| OwnedSlot {
            slot: slot(name, &[]),
            kind,
        })
        .collect();
    for role_id in ROLE_IDS {
        slots.push(OwnedSlot {
            slot: slot(
                "AccessControl_role_admin",
                &[Felt::from_hex(role_id).unwrap()],
            ),
            kind: "component:access_control:role_admin",
        });
    }
    for interface_id in INTERFACE_IDS {
        slots.push(OwnedSlot {
            slot: slot(
                "SRC5_supported_interfaces",
                &[Felt::from_hex(interface_id).unwrap()],
            ),
            kind: "component:src5:supported_interface",
        });
    }
    slots
}

/// `AccessControl_role_member[(role, grantee)]` slots for each grantee address
/// (from FETCH's `RoleGranted` scan), across every known role. We mark all
/// `roles × grantees` pairs because the event's role isn't threaded through;
/// pairs the contract never wrote are simply absent, so over-marking is a
/// harmless no-op and never hides a real anomaly (DESIGN §5.4).
pub fn grantee_role_member_slots(grantees: &[Felt]) -> Vec<OwnedSlot> {
    let mut slots = Vec::with_capacity(grantees.len() * ROLE_IDS.len());
    for &grantee in grantees {
        for role_id in ROLE_IDS {
            slots.push(OwnedSlot {
                slot: slot(
                    "AccessControl_role_member",
                    &[Felt::from_hex(role_id).unwrap(), grantee],
                ),
                kind: "component:access_control:role_member",
            });
        }
    }
    slots
}

#[cfg(test)]
mod tests {
    use discovery_core::privacy_pool::storage_slots;
    use starknet_types_core::felt::Felt;

    use super::*;

    #[test]
    fn test_singleton_address_matches_discovery_core() {
        // Cross-check our derivation against discovery-core's known selector.
        let slots = derivable_infra_slots();
        let auditor = slots
            .iter()
            .find(|s| s.kind == "singleton:auditor_public_key")
            .unwrap();
        assert_eq!(auditor.slot, storage_slots::auditor_public_key());
    }

    #[test]
    fn test_all_slots_present_and_distinct() {
        let slots = derivable_infra_slots();
        // 10 no-key slots + 10 role_admin + 2 interfaces.
        let expected = STATIC_INFRA_SLOTS.len() + ROLE_IDS.len() + INTERFACE_IDS.len();
        assert_eq!(slots.len(), expected);

        let mut addresses: Vec<Felt> = slots.iter().map(|s| s.slot).collect();
        assert!(addresses.iter().all(|&a| a != Felt::ZERO));
        addresses.sort();
        addresses.dedup();
        assert_eq!(addresses.len(), expected, "slots must be distinct");
    }

    #[test]
    fn test_role_admin_slots_present() {
        let slots = derivable_infra_slots();
        assert_eq!(
            slots
                .iter()
                .filter(|s| s.kind == "component:access_control:role_admin")
                .count(),
            ROLE_IDS.len()
        );
    }

    #[test]
    fn test_grantee_role_member_slots_shape() {
        let grantees = [Felt::from(0xAA_u64), Felt::from(0xBB_u64)];
        let slots = grantee_role_member_slots(&grantees);
        // One slot per (grantee, role); all distinct, all role_member.
        assert_eq!(slots.len(), grantees.len() * ROLE_IDS.len());
        assert!(slots
            .iter()
            .all(|s| s.kind == "component:access_control:role_member"));
        let distinct: std::collections::HashSet<Felt> = slots.iter().map(|s| s.slot).collect();
        assert_eq!(distinct.len(), slots.len());
    }

    #[test]
    fn test_grantee_role_member_matches_storage_var() {
        let grantee = Felt::from(0x123_u64);
        let role = Felt::from_hex(ROLE_IDS[0]).unwrap();
        let expected =
            get_storage_var_address("AccessControl_role_member", &[role, grantee]).unwrap();
        assert!(grantee_role_member_slots(&[grantee])
            .iter()
            .any(|s| s.slot == expected));
    }

    #[test]
    fn test_no_grantees_no_slots() {
        assert!(grantee_role_member_slots(&[]).is_empty());
    }

    #[test]
    fn test_kinds_follow_design_namespacing() {
        for slot in derivable_infra_slots() {
            assert!(
                slot.kind.starts_with("singleton:") || slot.kind.starts_with("component:"),
                "unexpected kind: {}",
                slot.kind
            );
        }
    }
}
