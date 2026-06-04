//! In-memory snapshot of privacy-pool contract storage, serialized as JSON.
//!
//! This is the artifact `fetch` produces and `analyze` consumes (see
//! `DESIGN.md`). It holds only public chain data plus the per-slot `kind`
//! classification that `analyze` fills in — never secret-derived data. A slot
//! whose `kind` is null is one `analyze` could not explain: the anomaly set
//! (`jq 'select(.kind == null)'`). Felts render as `0x` hex.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

/// A single contract storage slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotEntry {
    pub value: Felt,
    /// Block in which this slot was first written (its earliest state diff).
    pub created_block: u64,
    /// Block in which this slot last changed (write-once slots: == created_block).
    pub modified_block: u64,
    /// Classification set by `analyze`; `None` (JSON null) = unexplained = anomaly.
    #[serde(default)]
    pub kind: Option<String>,
}

/// A user discovered from a `ViewingKeySet` (or component role) event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub addr: Felt,
    pub kind: String,
}

/// The full snapshot: one JSON object with `meta`, `slots`, `users`, and
/// `balances` sections.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    /// Provenance: block, state root, contract address, auditor public key.
    #[serde(default)]
    pub meta: BTreeMap<String, String>,
    /// Contract storage, keyed by slot address.
    #[serde(default)]
    pub slots: HashMap<Felt, SlotEntry>,
    /// Registered users / role grantees.
    #[serde(default)]
    pub users: Vec<User>,
    /// token -> sum of unspent note amounts (filled by `analyze`).
    #[serde(default)]
    pub balances: HashMap<Felt, Felt>,
}

impl Snapshot {
    /// Records a non-zero storage slot (`kind` null until `analyze` classifies it).
    pub fn insert_slot(
        &mut self,
        slot: Felt,
        value: Felt,
        created_block: u64,
        modified_block: u64,
    ) {
        self.slots.insert(
            slot,
            SlotEntry {
                value,
                created_block,
                modified_block,
                kind: None,
            },
        );
    }

    /// Classifies a slot, marking it explained. Returns false if the slot is absent.
    pub fn set_kind(&mut self, slot: Felt, kind: &str) -> bool {
        match self.slots.get_mut(&slot) {
            Some(entry) => {
                entry.kind = Some(kind.to_string());
                true
            }
            None => false,
        }
    }

    /// Serializes to JSON bytes — the artifact handed over vsock.
    pub fn to_json_bytes(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec(self)
    }

    /// Parses a JSON snapshot produced by [`Snapshot::to_json_bytes`].
    pub fn from_json_bytes(bytes: &[u8]) -> serde_json::Result<Self> {
        serde_json::from_slice(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_set_kind_and_json_roundtrip() {
        let mut snap = Snapshot::default();
        snap.insert_slot(Felt::from(10u64), Felt::from(111u64), 5, 8);
        snap.insert_slot(Felt::from(20u64), Felt::from(222u64), 0, 0);
        assert!(snap.set_kind(Felt::from(10u64), "note"));
        assert!(!snap.set_kind(Felt::from(99u64), "note")); // absent slot
        snap.meta.insert("block".to_string(), "100".to_string());
        snap.balances
            .insert(Felt::from(0x1234u64), Felt::from(5000u64));

        let back = Snapshot::from_json_bytes(&snap.to_json_bytes().unwrap()).unwrap();

        let explained = &back.slots[&Felt::from(10u64)];
        assert_eq!(explained.value, Felt::from(111u64));
        assert_eq!(explained.created_block, 5);
        assert_eq!(explained.modified_block, 8);
        assert_eq!(explained.kind.as_deref(), Some("note"));
        assert!(back.slots[&Felt::from(20u64)].kind.is_none());
        assert_eq!(back.meta["block"], "100");
        assert_eq!(back.balances[&Felt::from(0x1234u64)], Felt::from(5000u64));

        // Anomaly set = slots with null kind.
        let anomalies = back.slots.values().filter(|e| e.kind.is_none()).count();
        assert_eq!(anomalies, 1);
    }

    #[test]
    fn test_felts_render_as_hex_strings() {
        let mut snap = Snapshot::default();
        snap.insert_slot(Felt::from(255u64), Felt::from(16u64), 0, 0);
        let json = String::from_utf8(snap.to_json_bytes().unwrap()).unwrap();
        assert!(json.contains("0x"), "felts should serialize as hex: {json}");
    }
}
