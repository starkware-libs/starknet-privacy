//! Privacy contract view methods and blanket implementation.

use async_trait::async_trait;
use num_traits::ToPrimitive;
use starknet_types_core::felt::Felt;

use super::storage_slots;
use super::types::{EncChannelInfo, EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo};
use crate::storage_backend::{RawStorageAccess, StorageError};

/// Privacy contract view methods.
#[async_trait]
pub trait IViews: Send + Sync {
    /// Checks if a channel with the given marker exists.
    async fn channel_exists(&self, channel_marker: Felt) -> Result<bool, StorageError>;

    /// Returns the number of channels for a recipient.
    async fn get_num_of_channels(&self, recipient_addr: Felt) -> Result<u64, StorageError>;

    /// Returns channel info for a recipient at the given index.
    async fn get_channel_info(
        &self,
        recipient_addr: Felt,
        channel_index: u64,
    ) -> Result<EncChannelInfo, StorageError>;

    /// Checks if a subchannel with the given marker exists.
    async fn subchannel_exists(&self, subchannel_marker: Felt) -> Result<bool, StorageError>;

    /// Returns encrypted subchannel info for the given id.
    async fn get_subchannel_info(
        &self,
        subchannel_id: Felt,
    ) -> Result<EncSubchannelInfo, StorageError>;

    /// Returns encrypted outgoing channel info for the given outgoing channel id.
    async fn get_outgoing_channel_info(
        &self,
        outgoing_channel_id: Felt,
    ) -> Result<EncOutgoingChannelInfo, StorageError>;

    /// Returns the note value for the given note ID.
    async fn get_note(&self, note_id: Felt) -> Result<Felt, StorageError>;

    /// Checks if a nullifier exists.
    async fn nullifier_exists(&self, nullifier: Felt) -> Result<bool, StorageError>;

    /// Returns a user's public viewing key.
    async fn get_public_key(&self, user_addr: Felt) -> Result<Felt, StorageError>;

    /// Returns a user's encrypted private key.
    async fn get_enc_private_key(&self, user_addr: Felt) -> Result<EncPrivateKey, StorageError>;

    /// Returns the compliance public key.
    async fn get_compliance_public_key(&self) -> Result<Felt, StorageError>;

    /// Batch-reads channel info for `count` consecutive channels starting at `start_index`.
    ///
    /// Returns a `Vec<EncChannelInfo>` of length `count`, fetched in a single `read_slots` call.
    async fn get_channel_info_batch(
        &self,
        recipient_addr: Felt,
        start_index: u64,
        count: usize,
    ) -> Result<Vec<EncChannelInfo>, StorageError>;

    /// Batch-reads packed note values for the given note IDs.
    ///
    /// Returns a `Vec<Felt>` matching the input length. Zero = note doesn't exist.
    async fn get_notes_batch(&self, note_ids: &[Felt]) -> Result<Vec<Felt>, StorageError>;

    /// Batch-reads packed note amounts and nullifier existence.
    ///
    /// Returns `(packed_amounts, nullifier_exists)`.
    /// Both vectors match the lengths of their respective inputs.
    async fn get_note_and_nullifier_batch(
        &self,
        note_ids: &[Felt],
        nullifiers: &[Felt],
    ) -> Result<(Vec<Felt>, Vec<bool>), StorageError>;
}

/// Checks that `values` has exactly `expected` elements, returning
/// [`StorageError::SlotCountMismatch`] otherwise.
fn check_slots_len(values: &[Felt], expected: usize) -> Result<(), StorageError> {
    if values.len() != expected {
        return Err(StorageError::SlotCountMismatch {
            expected,
            got: values.len(),
        });
    }
    Ok(())
}

/// Blanket implementation of `IViews` for any type implementing `RawStorageAccess`.
#[async_trait]
impl<T: RawStorageAccess> IViews for T {
    #[tracing::instrument(name = "channel_exists", level = "debug", skip(self))]
    async fn channel_exists(&self, channel_marker: Felt) -> Result<bool, StorageError> {
        let slot = storage_slots::channel_exists(channel_marker);
        let value = self.read_slot(slot).await?;
        Ok(value != Felt::ZERO)
    }

    #[tracing::instrument(name = "get_num_of_channels", level = "debug", skip(self))]
    async fn get_num_of_channels(&self, recipient_addr: Felt) -> Result<u64, StorageError> {
        // Channels are stored as a vector in contract storage.
        // The base slot contains the vector length (number of channels).
        let slot = storage_slots::recipient_channels_base(recipient_addr);
        let value = self.read_slot(slot).await?;
        value.to_u64().ok_or(StorageError::CastToU64Error(value))
    }

    #[tracing::instrument(name = "get_channel_info", level = "debug", skip(self))]
    async fn get_channel_info(
        &self,
        recipient_addr: Felt,
        channel_index: u64,
    ) -> Result<EncChannelInfo, StorageError> {
        let slots = storage_slots::recipient_channels_element(recipient_addr, channel_index);
        let values = self
            .read_slots(vec![
                slots.ephemeral_pubkey,
                slots.enc_channel_key,
                slots.enc_sender_addr,
            ])
            .await?;
        check_slots_len(&values, 3)?;
        Ok(EncChannelInfo {
            ephemeral_pubkey: values[0],
            enc_channel_key: values[1],
            enc_sender_addr: values[2],
        })
    }

    #[tracing::instrument(name = "subchannel_exists", level = "debug", skip(self))]
    async fn subchannel_exists(&self, subchannel_marker: Felt) -> Result<bool, StorageError> {
        let slot = storage_slots::subchannel_exists(subchannel_marker);
        let value = self.read_slot(slot).await?;
        Ok(value != Felt::ZERO)
    }

    #[tracing::instrument(name = "get_subchannel_info", level = "debug", skip(self))]
    async fn get_subchannel_info(
        &self,
        subchannel_id: Felt,
    ) -> Result<EncSubchannelInfo, StorageError> {
        let slots = storage_slots::subchannel_tokens(subchannel_id);
        let values = self.read_slots(vec![slots.salt, slots.enc_token]).await?;
        check_slots_len(&values, 2)?;
        Ok(EncSubchannelInfo {
            salt: values[0],
            enc_token: values[1],
        })
    }

    #[tracing::instrument(name = "get_outgoing_channel_info", level = "debug", skip(self))]
    async fn get_outgoing_channel_info(
        &self,
        outgoing_channel_id: Felt,
    ) -> Result<EncOutgoingChannelInfo, StorageError> {
        let slots = storage_slots::outgoing_channels(outgoing_channel_id);
        let values = self
            .read_slots(vec![slots.salt, slots.enc_recipient_addr])
            .await?;
        check_slots_len(&values, 2)?;
        Ok(EncOutgoingChannelInfo {
            salt: values[0],
            enc_recipient_addr: values[1],
        })
    }

    #[tracing::instrument(name = "get_note", level = "debug", skip(self))]
    async fn get_note(&self, note_id: Felt) -> Result<Felt, StorageError> {
        let slot = storage_slots::notes(note_id);
        self.read_slot(slot).await
    }

    #[tracing::instrument(name = "nullifier_exists", level = "debug", skip(self))]
    async fn nullifier_exists(&self, nullifier: Felt) -> Result<bool, StorageError> {
        let slot = storage_slots::nullifiers(nullifier);
        let value = self.read_slot(slot).await?;
        Ok(value != Felt::ZERO)
    }

    #[tracing::instrument(name = "get_public_key", level = "debug", skip(self))]
    async fn get_public_key(&self, user_addr: Felt) -> Result<Felt, StorageError> {
        let slot = storage_slots::public_key(user_addr);
        self.read_slot(slot).await
    }

    #[tracing::instrument(name = "get_enc_private_key", level = "debug", skip(self))]
    async fn get_enc_private_key(&self, user_addr: Felt) -> Result<EncPrivateKey, StorageError> {
        let slots = storage_slots::enc_private_key(user_addr);
        let values = self
            .read_slots(vec![slots.ephemeral_pubkey, slots.enc_private_key])
            .await?;
        check_slots_len(&values, 2)?;
        Ok(EncPrivateKey {
            ephemeral_pubkey: values[0],
            enc_private_key: values[1],
        })
    }

    #[tracing::instrument(name = "get_compliance_public_key", level = "debug", skip(self))]
    async fn get_compliance_public_key(&self) -> Result<Felt, StorageError> {
        let slot = storage_slots::compliance_public_key();
        self.read_slot(slot).await
    }

    #[tracing::instrument(
        name = "get_channel_info_batch",
        level = "debug",
        skip(self),
        fields(count)
    )]
    async fn get_channel_info_batch(
        &self,
        recipient_addr: Felt,
        start_index: u64,
        count: usize,
    ) -> Result<Vec<EncChannelInfo>, StorageError> {
        let mut slots = Vec::with_capacity(count * 3);
        for i in 0..count {
            let idx = start_index + i as u64;
            let s = storage_slots::recipient_channels_element(recipient_addr, idx);
            slots.push(s.ephemeral_pubkey);
            slots.push(s.enc_channel_key);
            slots.push(s.enc_sender_addr);
        }
        let values = self.read_slots(slots).await?;
        check_slots_len(&values, count * 3)?;
        let mut result = Vec::with_capacity(count);
        for chunk in values.chunks_exact(3) {
            result.push(EncChannelInfo {
                ephemeral_pubkey: chunk[0],
                enc_channel_key: chunk[1],
                enc_sender_addr: chunk[2],
            });
        }
        Ok(result)
    }

    #[tracing::instrument(
        name = "get_notes_batch",
        level = "debug",
        skip(self, note_ids),
        fields(count = note_ids.len())
    )]
    async fn get_notes_batch(&self, note_ids: &[Felt]) -> Result<Vec<Felt>, StorageError> {
        let slots: Vec<_> = note_ids
            .iter()
            .map(|&nid| storage_slots::notes(nid))
            .collect();
        let values = self.read_slots(slots).await?;
        check_slots_len(&values, note_ids.len())?;
        Ok(values)
    }

    #[tracing::instrument(
        name = "get_note_and_nullifier_batch",
        level = "debug",
        skip(self, note_ids, nullifiers)
    )]
    async fn get_note_and_nullifier_batch(
        &self,
        note_ids: &[Felt],
        nullifiers: &[Felt],
    ) -> Result<(Vec<Felt>, Vec<bool>), StorageError> {
        let n_notes = note_ids.len();
        let n_nullifiers = nullifiers.len();
        let total = n_notes + n_nullifiers;

        let mut slots = Vec::with_capacity(total);
        for &nid in note_ids {
            slots.push(storage_slots::notes(nid));
        }
        for &nul in nullifiers {
            slots.push(storage_slots::nullifiers(nul));
        }

        let values = self.read_slots(slots).await?;
        check_slots_len(&values, total)?;

        let packed_amounts = values[..n_notes].to_vec();
        let nullifier_exists: Vec<bool> =
            values[n_notes..].iter().map(|v| *v != Felt::ZERO).collect();

        Ok((packed_amounts, nullifier_exists))
    }
}
