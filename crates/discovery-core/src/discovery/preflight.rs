//! Transfer readiness check (preflight).
//!
//! Checks what setup is needed before a sender can transfer a specific
//! token to a specific recipient.

use starknet_types_core::felt::Felt;

use super::DiscoveryError;
use crate::privacy_pool::hashes::{
    compute_channel_key, compute_channel_marker, compute_subchannel_marker,
};
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// Result of a preflight check — three boolean flags indicating setup state.
#[derive(Debug, Clone)]
pub struct PreflightOutput {
    /// Whether the sender has a public key registered on-chain.
    pub sender_registered: bool,
    /// Whether the channel from sender to recipient exists.
    pub channel_exists: bool,
    /// Whether the token subchannel exists within the channel.
    pub subchannel_exists: bool,
}

/// Checks transfer readiness for a `(sender, recipient, token)` tuple.
///
/// Performs at most 4 direct storage lookups (no scanning, no budget needed).
/// Each subsequent check depends on the previous one — if the recipient isn't
/// registered, we can't derive the channel key to check channel/subchannel existence.
pub async fn preflight<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    viewing_key: &SecretFelt,
    recipient: Felt,
    token: Felt,
) -> Result<PreflightOutput, DiscoveryError> {
    // 1. Sender must be registered (caller error if not — can't derive anything)
    let sender_pk = pool.get_public_key(sender_addr).await?;
    if sender_pk == Felt::ZERO {
        return Ok(PreflightOutput {
            sender_registered: false,
            channel_exists: false,
            subchannel_exists: false,
        });
    }

    // 2. Check recipient registration
    let recipient_pk = pool.get_public_key(recipient).await?;
    if recipient_pk == Felt::ZERO {
        return Ok(PreflightOutput {
            sender_registered: true,
            channel_exists: false,
            subchannel_exists: false,
        });
    }

    // 3. Check channel existence
    let channel_key = compute_channel_key(sender_addr, viewing_key, recipient, recipient_pk);
    let channel_marker = compute_channel_marker(channel_key, sender_addr, recipient, recipient_pk);
    let channel_exists = pool.channel_exists(channel_marker).await?;
    if !channel_exists {
        return Ok(PreflightOutput {
            sender_registered: true,
            channel_exists: false,
            subchannel_exists: false,
        });
    }

    // 4. Check subchannel existence
    let subchannel_marker = compute_subchannel_marker(channel_key, recipient, recipient_pk, token);
    let subchannel_exists = pool.subchannel_exists(subchannel_marker).await?;

    Ok(PreflightOutput {
        sender_registered: true,
        channel_exists: true,
        subchannel_exists,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::load_devnet_fixture;

    #[tokio::test]
    async fn test_preflight_ready() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);
        let c = &fixture.constants;

        let viewing_key = SecretFelt::new(c.alice_viewing_key);
        let result = preflight(
            &backend,
            c.alice_address,
            &viewing_key,
            c.bob_address,
            c.strk_token,
        )
        .await
        .unwrap();

        assert!(result.sender_registered);
        assert!(result.channel_exists);
        assert!(result.subchannel_exists);
    }

    #[tokio::test]
    async fn test_preflight_setup_channel_unknown_recipient() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);
        let c = &fixture.constants;

        let viewing_key = SecretFelt::new(c.alice_viewing_key);
        let unknown = Felt::from_hex_unchecked("0xdead");
        let result = preflight(
            &backend,
            c.alice_address,
            &viewing_key,
            unknown,
            c.strk_token,
        )
        .await
        .unwrap();

        assert!(result.sender_registered);
        assert!(!result.channel_exists);
        assert!(!result.subchannel_exists);
    }

    #[tokio::test]
    async fn test_preflight_register_unknown_sender() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);
        let c = &fixture.constants;

        let viewing_key = SecretFelt::new(Felt::from_hex_unchecked("0xbad"));
        let unknown_sender = Felt::from_hex_unchecked("0xdead");
        let result = preflight(
            &backend,
            unknown_sender,
            &viewing_key,
            c.bob_address,
            c.strk_token,
        )
        .await
        .unwrap();

        assert!(!result.sender_registered);
        assert!(!result.channel_exists);
        assert!(!result.subchannel_exists);
    }
}
