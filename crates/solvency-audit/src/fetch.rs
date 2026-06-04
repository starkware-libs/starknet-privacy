//! Reconstructs the contract's storage at a pinned block by folding state
//! diffs, and writes it into a snapshot.

use std::collections::HashMap;

use starknet_types_core::felt::Felt;

use crate::snapshot::Snapshot;
use crate::state_source::StateSource;

/// Final value of a slot with its first-written (created) and last-written
/// (modified) blocks. Equal for write-once slots; differ for ones rewritten
/// (e.g. an open note funded by a later deposit).
type SlotState = (Felt, u64, u64);

/// Folds per-block storage diffs across `from..=to` into the contract's final
/// non-zero storage. Last write wins; a write of zero deletes the slot (so a
/// slot set and later cleared does not appear). For each surviving slot we keep
/// the block it was first written and the block it last changed — useful for
/// later tracing an unexplained slot back to its transaction(s).
pub async fn fold_storage<S: StateSource>(
    source: &S,
    from: u64,
    to: u64,
) -> Result<HashMap<Felt, SlotState>, S::Error> {
    let mut state: HashMap<Felt, SlotState> = HashMap::new();
    for block in from..=to {
        for (slot, value) in source.storage_diffs_at(block).await? {
            if value == Felt::ZERO {
                state.remove(&slot);
            } else {
                state
                    .entry(slot)
                    .and_modify(|entry| {
                        entry.0 = value;
                        entry.2 = block; // modified
                    })
                    .or_insert((value, block, block)); // created == modified
            }
        }
    }
    Ok(state)
}

/// Writes a folded storage map into the snapshot's `slots` (with `kind` left
/// null until `analyze` classifies each slot).
pub fn populate_storage(snapshot: &mut Snapshot, state: &HashMap<Felt, SlotState>) {
    for (slot, (value, created, modified)) in state {
        snapshot.insert_slot(*slot, *value, *created, *modified);
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use async_trait::async_trait;

    use super::*;

    /// Block -> the storage writes applied in that block.
    struct MockSource(HashMap<u64, Vec<(Felt, Felt)>>);

    #[async_trait]
    impl StateSource for MockSource {
        type Error = Infallible;
        async fn storage_diffs_at(&self, block: u64) -> Result<Vec<(Felt, Felt)>, Infallible> {
            Ok(self.0.get(&block).cloned().unwrap_or_default())
        }
    }

    fn slot(n: u64) -> Felt {
        Felt::from(n)
    }

    #[tokio::test]
    async fn test_fold_last_write_wins_and_zero_deletes() {
        let source = MockSource(HashMap::from([
            (
                1,
                vec![
                    (slot(0xA), Felt::from(10u64)),
                    (slot(0xB), Felt::from(20u64)),
                ],
            ),
            (2, vec![(slot(0xA), Felt::from(11u64))]), // overwrite A
            (3, vec![(slot(0xB), Felt::ZERO)]),        // clear B
        ]));

        let state = fold_storage(&source, 1, 3).await.unwrap();

        assert_eq!(state.len(), 1);
        // A: created at block 1, last modified at block 2, final value 11.
        assert_eq!(state[&slot(0xA)], (Felt::from(11u64), 1, 2));
        assert!(!state.contains_key(&slot(0xB))); // cleared slot is gone
    }

    #[tokio::test]
    async fn test_populate_storage_writes_folded_state() {
        let source = MockSource(HashMap::from([
            (5, vec![(slot(0xA), Felt::from(10u64))]),
            (7, vec![(slot(0xA), Felt::from(99u64))]),
        ]));
        let state = fold_storage(&source, 5, 7).await.unwrap();

        let mut snapshot = Snapshot::default();
        populate_storage(&mut snapshot, &state);

        let entry = &snapshot.slots[&slot(0xA)];
        assert_eq!(entry.value, Felt::from(99u64));
        assert_eq!(entry.created_block, 5);
        assert_eq!(entry.modified_block, 7);
        assert!(entry.kind.is_none());
    }
}
