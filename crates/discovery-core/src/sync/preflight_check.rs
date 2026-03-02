//! Transfer readiness check (preflight).
//!
//! Checks what setup is needed before a sender can transfer a specific
//! token to a specific recipient.

use starknet_types_core::felt::Felt;

use tracing::debug;

use crate::discovery::DiscoveryError;
use crate::privacy_pool::felt_hex;
use crate::privacy_pool::hashes::{
    compute_channel_key, compute_channel_marker, compute_subchannel_marker,
};
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// Result of a preflight check — three boolean flags indicating setup state.
#[derive(Debug, Clone)]
pub struct PreflightCheckResult {
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
pub async fn preflight_check<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    decryption_key: &SecretFelt,
    recipient: Felt,
    token: Felt,
) -> Result<PreflightCheckResult, DiscoveryError> {
    // 1. Sender must be registered (caller error if not — can't derive anything)
    let sender_pk = pool.get_public_key(sender_addr).await?;
    if sender_pk == Felt::ZERO {
        return Ok(PreflightCheckResult {
            sender_registered: false,
            channel_exists: false,
            subchannel_exists: false,
        });
    }

    // 2. Check recipient registration
    let recipient_pk = pool.get_public_key(recipient).await?;
    if recipient_pk == Felt::ZERO {
        return Ok(PreflightCheckResult {
            sender_registered: true,
            channel_exists: false,
            subchannel_exists: false,
        });
    }

    // 3. Check channel existence
    let channel_key = compute_channel_key(sender_addr, decryption_key, recipient, recipient_pk);
    let channel_marker = compute_channel_marker(&channel_key, sender_addr, recipient, recipient_pk);
    let channel_exists = pool.channel_exists(channel_marker).await?;
    if !channel_exists {
        return Ok(PreflightCheckResult {
            sender_registered: true,
            channel_exists: false,
            subchannel_exists: false,
        });
    }

    // 4. Check subchannel existence
    let subchannel_marker = compute_subchannel_marker(&channel_key, recipient, recipient_pk, token);
    let subchannel_exists = pool.subchannel_exists(subchannel_marker).await?;

    debug!(
        sender = felt_hex(&sender_addr),
        recipient = felt_hex(&recipient),
        token = felt_hex(&token),
        channel_exists = true,
        subchannel_exists,
        "preflight_check done"
    );

    Ok(PreflightCheckResult {
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

        let decryption_key = &c.alice_viewing_key;
        let result = preflight_check(
            &backend,
            c.alice_address,
            decryption_key,
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

        let decryption_key = &c.alice_viewing_key;
        let unknown = Felt::from_hex_unchecked("0xdead");
        let result = preflight_check(
            &backend,
            c.alice_address,
            decryption_key,
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

        let decryption_key = SecretFelt::new(Felt::from_hex_unchecked("0xbad"));
        let unknown_sender = Felt::from_hex_unchecked("0xdead");
        let result = preflight_check(
            &backend,
            unknown_sender,
            &decryption_key,
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
