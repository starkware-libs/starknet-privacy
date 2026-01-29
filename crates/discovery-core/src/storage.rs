//! Storage interface for the privacy contract.

use async_trait::async_trait;
use num_traits::ToPrimitive;
use starknet_core::types::BlockId;
use starknet_types_core::felt::Felt;
use thiserror::Error;

use crate::storage_slots;
use crate::types::{EncChannelInfo, EncPrivateKey, EncSubchannelInfo};

/// Errors that can occur during storage operations.
#[derive(Debug, Error)]
pub enum StorageError {
    /// Failed to compute storage slot address.
    #[error("slot computation failed: {0}")]
    SlotComputation(#[from] anyhow::Error),
    /// Failed to convert value to u64.
    #[error("value is too large to convert to u64: {0}")]
    CastToU64Error(Felt),
    /// Backend-specific error.
    #[error("{0}")]
    Backend(#[source] Box<dyn std::error::Error + Send + Sync>),
}

/// Factory for creating storage snapshots bound to a specific block.
#[async_trait]
pub trait StorageBackend: Send + Sync {
    /// The snapshot type produced by this backend.
    type Snapshot: StorageSnapshot;

    /// Creates a snapshot at the specified block.
    /// If `block_id` is `None`, uses the latest block.
    async fn snapshot(&self, block_id: Option<BlockId>) -> Result<Self::Snapshot, StorageError>;
}

/// Consistent view of storage at a specific block.
#[async_trait]
pub trait StorageSnapshot: IViews {
    /// Returns the block ID this snapshot is bound to.
    fn block_id(&self) -> BlockId;
}

/// Privacy contract view methods.
#[async_trait]
pub trait IViews: Send + Sync {
    /// Checks if a channel with the given ID exists.
    async fn channel_exists(&self, channel_id: Felt) -> Result<bool, StorageError>;

    /// Returns the number of channels for a recipient.
    async fn get_num_of_channels(&self, recipient_addr: Felt) -> Result<u64, StorageError>;

    /// Returns channel info for a recipient at the given index.
    async fn get_channel_info(
        &self,
        recipient_addr: Felt,
        channel_index: u64,
    ) -> Result<EncChannelInfo, StorageError>;

    /// Checks if a subchannel with the given ID exists.
    async fn subchannel_exists(&self, subchannel_id: Felt) -> Result<bool, StorageError>;

    /// Returns encrypted subchannel info for the given key.
    async fn get_subchannel_info(
        &self,
        subchannel_key: Felt,
    ) -> Result<EncSubchannelInfo, StorageError>;

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
}

/// Low-level storage access for reading raw storage slots.
#[async_trait]
pub trait RawStorageAccess: Send + Sync {
    /// Reads a single storage slot.
    async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError>;

    /// Reads multiple storage slots.
    async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError>;
}

/// Blanket implementation of `IViews` for any type implementing `RawStorageAccess`.
#[async_trait]
impl<T: RawStorageAccess> IViews for T {
    #[tracing::instrument(name = "channel_exists", level = "debug", skip(self))]
    async fn channel_exists(&self, channel_id: Felt) -> Result<bool, StorageError> {
        let slot = storage_slots::channel_exists(channel_id)?;
        let value = self.read_slot(slot).await?;
        Ok(value != Felt::ZERO)
    }

    #[tracing::instrument(name = "get_num_of_channels", level = "debug", skip(self))]
    async fn get_num_of_channels(&self, recipient_addr: Felt) -> Result<u64, StorageError> {
        let slot = storage_slots::recipient_channels_base(recipient_addr)?;
        let value = self.read_slot(slot).await?;
        Ok(value.to_u64().ok_or(StorageError::CastToU64Error(value))?)
    }

    #[tracing::instrument(name = "get_channel_info", level = "debug", skip(self))]
    async fn get_channel_info(
        &self,
        recipient_addr: Felt,
        channel_index: u64,
    ) -> Result<EncChannelInfo, StorageError> {
        let slots = storage_slots::recipient_channels_element(recipient_addr, channel_index)?;
        let values = self
            .read_slots(vec![
                slots.ephemeral_pubkey,
                slots.enc_channel_key,
                slots.enc_sender_addr,
            ])
            .await?;
        Ok(EncChannelInfo {
            ephemeral_pubkey: values[0],
            enc_channel_key: values[1],
            enc_sender_addr: values[2],
        })
    }

    #[tracing::instrument(name = "subchannel_exists", level = "debug", skip(self))]
    async fn subchannel_exists(&self, subchannel_id: Felt) -> Result<bool, StorageError> {
        let slot = storage_slots::subchannel_exists(subchannel_id)?;
        let value = self.read_slot(slot).await?;
        Ok(value != Felt::ZERO)
    }

    #[tracing::instrument(name = "get_subchannel_info", level = "debug", skip(self))]
    async fn get_subchannel_info(
        &self,
        subchannel_key: Felt,
    ) -> Result<EncSubchannelInfo, StorageError> {
        let slots = storage_slots::subchannel_tokens(subchannel_key)?;
        let values = self.read_slots(vec![slots.salt, slots.enc_token]).await?;
        Ok(EncSubchannelInfo {
            salt: values[0],
            enc_token: values[1],
        })
    }

    #[tracing::instrument(name = "get_note", level = "debug", skip(self))]
    async fn get_note(&self, note_id: Felt) -> Result<Felt, StorageError> {
        let slot = storage_slots::notes(note_id)?;
        self.read_slot(slot).await
    }

    #[tracing::instrument(name = "nullifier_exists", level = "debug", skip(self))]
    async fn nullifier_exists(&self, nullifier: Felt) -> Result<bool, StorageError> {
        let slot = storage_slots::nullifiers(nullifier)?;
        let value = self.read_slot(slot).await?;
        Ok(value != Felt::ZERO)
    }

    #[tracing::instrument(name = "get_public_key", level = "debug", skip(self))]
    async fn get_public_key(&self, user_addr: Felt) -> Result<Felt, StorageError> {
        let slot = storage_slots::public_key(user_addr)?;
        self.read_slot(slot).await
    }

    #[tracing::instrument(name = "get_enc_private_key", level = "debug", skip(self))]
    async fn get_enc_private_key(&self, user_addr: Felt) -> Result<EncPrivateKey, StorageError> {
        let slots = storage_slots::enc_private_key(user_addr)?;
        let values = self
            .read_slots(vec![slots.ephemeral_pubkey, slots.enc_private_key])
            .await?;
        Ok(EncPrivateKey {
            ephemeral_pubkey: values[0],
            enc_private_key: values[1],
        })
    }

    #[tracing::instrument(name = "get_compliance_public_key", level = "debug", skip(self))]
    async fn get_compliance_public_key(&self) -> Result<Felt, StorageError> {
        let slot = storage_slots::compliance_public_key()?;
        self.read_slot(slot).await
    }
}
