//! `RawStorageAccess` over a snapshot's slots, so discovery-core can run
//! directly against the snapshot (it gets `IViews` via the blanket impl).

use std::collections::HashMap;

use async_trait::async_trait;
use discovery_core::storage_backend::{RawStorageAccess, StorageError};
use starknet_core::types::StorageResult;
use starknet_types_core::felt::Felt;

use crate::snapshot::Snapshot;

/// In-memory view of a snapshot's storage for discovery reads. Built once, then
/// reads are pure lookups — so it is `Send + Sync` and safe for concurrent
/// discovery, and missing slots read as zero (mirroring a Cairo map).
pub struct SnapshotBackend {
    slots: HashMap<Felt, (Felt, u64)>,
}

impl SnapshotBackend {
    /// Builds a read backend from a snapshot's slots.
    pub fn from_snapshot(snapshot: &Snapshot) -> Self {
        let slots = snapshot
            .slots
            .iter()
            .map(|(slot, entry)| (*slot, (entry.value, entry.modified_block)))
            .collect();
        Self { slots }
    }

    fn get(&self, slot: Felt) -> (Felt, u64) {
        self.slots.get(&slot).copied().unwrap_or((Felt::ZERO, 0))
    }
}

#[async_trait]
impl RawStorageAccess for SnapshotBackend {
    async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError> {
        Ok(self.get(slot).0)
    }

    async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError> {
        Ok(slots.into_iter().map(|slot| self.get(slot).0).collect())
    }

    async fn read_slots_with_block(
        &self,
        slots: Vec<Felt>,
    ) -> Result<Vec<StorageResult>, StorageError> {
        Ok(slots
            .into_iter()
            .map(|slot| {
                let (value, last_update_block) = self.get(slot);
                StorageResult {
                    value,
                    last_update_block,
                }
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_reads_present_and_missing_slots() {
        let mut snapshot = Snapshot::default();
        snapshot.insert_slot(Felt::from(0xA_u64), Felt::from(111u64), 4, 7);
        let backend = SnapshotBackend::from_snapshot(&snapshot);

        // Present slot.
        assert_eq!(
            backend.read_slot(Felt::from(0xA_u64)).await.unwrap(),
            Felt::from(111u64)
        );
        // Missing slot reads as zero.
        assert_eq!(
            backend.read_slot(Felt::from(0xB_u64)).await.unwrap(),
            Felt::ZERO
        );

        // Batch read preserves order and zero-fills misses.
        let values = backend
            .read_slots(vec![Felt::from(0xA_u64), Felt::from(0xB_u64)])
            .await
            .unwrap();
        assert_eq!(values, vec![Felt::from(111u64), Felt::ZERO]);

        // With-block read carries the recorded block (0 for misses).
        let with_block = backend
            .read_slots_with_block(vec![Felt::from(0xA_u64), Felt::from(0xB_u64)])
            .await
            .unwrap();
        assert_eq!(with_block[0].value, Felt::from(111u64));
        assert_eq!(with_block[0].last_update_block, 7);
        assert_eq!(with_block[1].value, Felt::ZERO);
        assert_eq!(with_block[1].last_update_block, 0);
    }
}
