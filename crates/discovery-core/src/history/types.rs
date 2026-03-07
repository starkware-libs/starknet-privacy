//! Types for the backward history scan.

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use crate::privacy_pool::events::PrivacyPoolEvent;
use crate::privacy_pool::types::SecretFelt;

/// Direction of the channel from the scanning user's perspective.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelKind {
    Incoming,
    Outgoing,
    SelfChannel,
}

/// A note creation event read from on-chain storage during backward history scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateNoteEvent {
    pub channel_kind: ChannelKind,
    pub token: Felt,
    pub note_index: u64,
    pub note_id: Felt,
    pub amount: u128,
    /// The other party: sender for Incoming, recipient for Outgoing, self address for SelfChannel.
    pub counterparty: Felt,
    /// Whether this note is an open note (salt == OPEN_NOTE_SALT). Open notes are part of swaps.
    pub is_open: bool,
}

/// A unified event in the history timeline.
///
/// Groups note creation events with on-chain deposit/withdrawal events
/// for presentation in client action history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HistoryEvent {
    NoteCreated(CreateNoteEvent),
    OnChain(PrivacyPoolEvent),
}

/// A single event stream in the backward history scan.
///
/// Each subchannel produces one source (note creation reads only).
pub struct HistoryEventSource {
    pub channel_key: SecretFelt,
    pub token: Felt,
    pub channel_kind: ChannelKind,
    /// The other party: sender for Incoming, recipient for Outgoing, self address for SelfChannel.
    pub counterparty: Felt,
    /// Next note index to read (descending). None = stream exhausted.
    pub next_index: Option<u64>,
}

/// Cursor for paginated backward history scan across multiple event sources.
/// Pass to [`super::note_events::fetch_aggregated_note_events`] and reuse across calls for pagination.
pub struct HistoryCursor {
    pub event_sources: Vec<HistoryEventSource>,
}
