//! The online FETCH stage (DESIGN.md §4): reconstructs the contract's storage at
//! a pinned block by folding state diffs, scans `ViewingKeySet` events for the
//! candidate user list and `RoleGranted` events for infra grantees, records
//! provenance meta, and serializes the snapshot.

use std::collections::{BTreeMap, HashMap};

use discovery_core::privacy_pool::storage_slots;
use starknet_core::types::{
    AddressFilter, BlockId, EmittedEvent, EventFilter, MaybePreConfirmedStateUpdate,
};
use starknet_core::utils::starknet_keccak;
use starknet_providers::{Provider, ProviderError};
use starknet_types_core::felt::Felt;
use url::Url;

use crate::snapshot::{Snapshot, User};
use crate::state_source::{JsonRpcStateSource, StateSource};

/// Page size for the `ViewingKeySet` event scan.
const EVENT_CHUNK_SIZE: u64 = 1024;
/// `users` entry kind for a `ViewingKeySet`-registered user (matches `analyze`).
const VIEWING_KEY_USER: &str = "viewing_key";
/// `users` entry kind for an address granted a component role (matches `analyze`).
const INFRA_GRANTEE_USER: &str = "infra_grantee";

/// Why FETCH could not produce a snapshot.
#[derive(Debug)]
pub enum FetchError {
    /// An RPC call to the node failed.
    Rpc(ProviderError),
    /// The assembled snapshot could not be serialized.
    Json(serde_json::Error),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rpc(e) => write!(f, "node RPC call failed: {e}"),
            Self::Json(e) => write!(f, "snapshot serialization failed: {e}"),
        }
    }
}

impl std::error::Error for FetchError {}

impl From<ProviderError> for FetchError {
    fn from(e: ProviderError) -> Self {
        Self::Rpc(e)
    }
}

impl From<serde_json::Error> for FetchError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

/// Builds the snapshot JSON bytes for `contract` over blocks `from..=to`
/// (DESIGN.md §4): folds state-diffs into storage, records `meta` (block,
/// state root, contract, on-chain auditor public key), and scans `ViewingKeySet`
/// events into the candidate user list.
///
/// `from` should be the deploy block (or earlier) and `to` the pinned, L1-final
/// audit block. The bytes are exactly what `analyze` consumes.
pub async fn fetch(
    rpc_url: Url,
    contract: Felt,
    from: u64,
    to: u64,
) -> Result<Vec<u8>, FetchError> {
    let source = JsonRpcStateSource::new(rpc_url, contract);

    let state = fold_storage(&source, from, to).await?;
    let mut snapshot = Snapshot::default();
    populate_storage(&mut snapshot, &state);

    let provider = source.provider();
    let state_root = match provider.get_state_update(BlockId::Number(to)).await? {
        MaybePreConfirmedStateUpdate::Update(update) => update.new_root,
        MaybePreConfirmedStateUpdate::PreConfirmedUpdate(_) => Felt::ZERO,
    };
    // The auditor public key is on-chain storage — read it from the folded
    // snapshot rather than issuing a separate query.
    let auditor_public_key = snapshot
        .slots
        .get(&storage_slots::auditor_public_key())
        .map_or(Felt::ZERO, |entry| entry.value);

    // Candidate viewing-key users (incoming/outgoing attribution) plus role
    // grantees (infra `role_member` attribution, §5.4).
    let mut users = fetch_viewing_key_users(provider, contract, from, to).await?;
    users.extend(fetch_role_grantees(provider, contract, from, to).await?);
    snapshot.users = users;
    snapshot.meta = build_meta(to, state_root, contract, auditor_public_key);
    Ok(snapshot.to_json_bytes()?)
}

/// Paginates a single-selector event scan over `contract` for `from..=to`,
/// following continuation tokens to the last page.
async fn scan_events<P: Provider + Sync>(
    provider: &P,
    contract: Felt,
    from: u64,
    to: u64,
    selector: Felt,
) -> Result<Vec<EmittedEvent>, ProviderError> {
    let filter = EventFilter {
        from_block: Some(BlockId::Number(from)),
        to_block: Some(BlockId::Number(to)),
        address: Some(AddressFilter::Single(contract)),
        keys: Some(vec![vec![selector]]),
    };

    let mut events = Vec::new();
    let mut continuation_token = None;
    loop {
        let page = provider
            .get_events(filter.clone(), continuation_token, EVENT_CHUNK_SIZE)
            .await?;
        events.extend(page.events);
        continuation_token = page.continuation_token;
        if continuation_token.is_none() {
            break;
        }
    }
    Ok(events)
}

/// Scans `ViewingKeySet` events over `from..=to` for the distinct registered
/// users (DESIGN.md §4.2). Best-effort per §2: under the bug events can be
/// omitted, so this is "users we can attribute," not a complete set.
async fn fetch_viewing_key_users<P: Provider + Sync>(
    provider: &P,
    contract: Felt,
    from: u64,
    to: u64,
) -> Result<Vec<User>, ProviderError> {
    let events = scan_events(
        provider,
        contract,
        from,
        to,
        starknet_keccak(b"ViewingKeySet"),
    )
    .await?;
    Ok(viewing_key_users(&events))
}

/// Scans `RoleGranted` events over `from..=to` for the distinct addresses
/// granted a component role (DESIGN.md §5.4), used to attribute `role_member`
/// slots. Noise-reduction only — not part of the security guarantee.
async fn fetch_role_grantees<P: Provider + Sync>(
    provider: &P,
    contract: Felt,
    from: u64,
    to: u64,
) -> Result<Vec<User>, ProviderError> {
    let events = scan_events(
        provider,
        contract,
        from,
        to,
        starknet_keccak(b"RoleGranted"),
    )
    .await?;
    Ok(role_grantees(&events))
}

/// Extracts distinct user addresses from `ViewingKeySet` events, preserving
/// first-seen order. Keys layout: `[selector, user_addr, public_key]`; events
/// missing the address key are skipped (a malformed event is not a user).
fn viewing_key_users(events: &[EmittedEvent]) -> Vec<User> {
    let mut seen = std::collections::HashSet::new();
    events
        .iter()
        .filter_map(|event| event.keys.get(1).copied())
        .filter(|addr| seen.insert(*addr))
        .map(|addr| User {
            addr,
            kind: VIEWING_KEY_USER.to_string(),
        })
        .collect()
}

/// Extracts distinct grantee addresses from `RoleGranted` events, preserving
/// first-seen order. The event has no `#[key]` fields, so data layout is
/// `[role, account, sender]` and the grantee is `data[1]`; malformed events are
/// skipped.
fn role_grantees(events: &[EmittedEvent]) -> Vec<User> {
    let mut seen = std::collections::HashSet::new();
    events
        .iter()
        .filter_map(|event| event.data.get(1).copied())
        .filter(|addr| seen.insert(*addr))
        .map(|addr| User {
            addr,
            kind: INFRA_GRANTEE_USER.to_string(),
        })
        .collect()
}

/// Assembles the snapshot `meta` map (DESIGN.md §4.3); all felts render as hex.
fn build_meta(
    block_number: u64,
    state_root: Felt,
    contract: Felt,
    auditor_public_key: Felt,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("block_number".to_string(), block_number.to_string()),
        ("state_root".to_string(), format!("{state_root:#x}")),
        ("contract_address".to_string(), format!("{contract:#x}")),
        (
            "auditor_public_key".to_string(),
            format!("{auditor_public_key:#x}"),
        ),
    ])
}

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

    fn viewing_key_event(user_addr: u64) -> EmittedEvent {
        EmittedEvent {
            from_address: Felt::from(0xC0_u64),
            // [selector, user_addr, public_key]
            keys: vec![
                starknet_keccak(b"ViewingKeySet"),
                Felt::from(user_addr),
                Felt::from(0xABC_u64),
            ],
            data: vec![],
            block_hash: None,
            block_number: Some(1),
            transaction_hash: Felt::ZERO,
            transaction_index: 0,
            event_index: 0,
        }
    }

    #[test]
    fn test_viewing_key_users_dedups_preserving_order() {
        let events = vec![
            viewing_key_event(0x10),
            viewing_key_event(0x20),
            viewing_key_event(0x10), // re-registration of the same user
        ];
        let users = viewing_key_users(&events);

        assert_eq!(users.len(), 2);
        assert_eq!(users[0].addr, Felt::from(0x10u64));
        assert_eq!(users[1].addr, Felt::from(0x20u64));
        assert!(users.iter().all(|u| u.kind == VIEWING_KEY_USER));
    }

    #[test]
    fn test_viewing_key_users_skips_malformed() {
        // Event with only the selector key (no user_addr) is not a user.
        let malformed = EmittedEvent {
            from_address: Felt::from(0xC0_u64),
            keys: vec![starknet_keccak(b"ViewingKeySet")],
            data: vec![],
            block_hash: None,
            block_number: Some(1),
            transaction_hash: Felt::ZERO,
            transaction_index: 0,
            event_index: 0,
        };
        assert!(viewing_key_users(&[malformed]).is_empty());
    }

    fn role_granted_event(role: u64, account: u64) -> EmittedEvent {
        EmittedEvent {
            from_address: Felt::from(0xC0_u64),
            keys: vec![starknet_keccak(b"RoleGranted")],
            // No #[key] fields: data = [role, account, sender].
            data: vec![Felt::from(role), Felt::from(account), Felt::from(0x999_u64)],
            block_hash: None,
            block_number: Some(1),
            transaction_hash: Felt::ZERO,
            transaction_index: 0,
            event_index: 0,
        }
    }

    #[test]
    fn test_role_grantees_extracts_account_and_dedups() {
        let events = vec![
            role_granted_event(0x1, 0xAA),
            role_granted_event(0x2, 0xAA), // same account, different role
            role_granted_event(0x1, 0xBB),
        ];
        let grantees = role_grantees(&events);
        assert_eq!(grantees.len(), 2); // distinct accounts AA, BB
        assert_eq!(grantees[0].addr, Felt::from(0xAA_u64));
        assert_eq!(grantees[1].addr, Felt::from(0xBB_u64));
        assert!(grantees.iter().all(|u| u.kind == INFRA_GRANTEE_USER));
    }

    #[test]
    fn test_role_grantees_skips_malformed() {
        // Fewer than two data felts → no account.
        let malformed = EmittedEvent {
            from_address: Felt::from(0xC0_u64),
            keys: vec![starknet_keccak(b"RoleGranted")],
            data: vec![Felt::from(0x1_u64)],
            block_hash: None,
            block_number: Some(1),
            transaction_hash: Felt::ZERO,
            transaction_index: 0,
            event_index: 0,
        };
        assert!(role_grantees(&[malformed]).is_empty());
    }

    #[test]
    fn test_build_meta_renders_felts_as_hex() {
        let meta = build_meta(
            42,
            Felt::from(0xB0070_u64),
            Felt::from(0xC0_u64),
            Felt::from(0xA0D_u64),
        );
        assert_eq!(meta["block_number"], "42");
        assert_eq!(meta["contract_address"], "0xc0");
        assert_eq!(meta["auditor_public_key"], "0xa0d");
        assert!(meta["state_root"].starts_with("0x"));
        assert!(!meta.contains_key("class_hash"));
    }
}
