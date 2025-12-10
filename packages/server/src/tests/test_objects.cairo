use core::num::traits::Zero;
use server::objects::{EncChannel, EncChannelTrait};

#[test]
fn test_enc_channel_is_non_zero() {
    let mut enc_channel = EncChannel {
        ephemeral_pubkey: 'EPHEMERAL_PUBKEY'.try_into().unwrap(),
        enc_channel_key: 'ENC_CHANNEL_KEY'.try_into().unwrap(),
        enc_token: 'ENC_TOKEN'.try_into().unwrap(),
        enc_sender_addr: 'ENC_SENDER_ADDR'.try_into().unwrap(),
    };
    assert_eq!(enc_channel.is_non_zero(), true);
    enc_channel.ephemeral_pubkey = Zero::zero();
    assert_eq!(enc_channel.is_non_zero(), false);
    enc_channel.ephemeral_pubkey = 'EPHEMERAL_PUBKEY'.try_into().unwrap();
    enc_channel.enc_channel_key = Zero::zero();
    assert_eq!(enc_channel.is_non_zero(), false);
    enc_channel.enc_channel_key = 'ENC_CHANNEL_KEY'.try_into().unwrap();
    enc_channel.enc_token = Zero::zero();
    assert_eq!(enc_channel.is_non_zero(), false);
    enc_channel.enc_token = 'ENC_TOKEN'.try_into().unwrap();
    enc_channel.enc_sender_addr = Zero::zero();
    assert_eq!(enc_channel.is_non_zero(), false);
    let enc_channel_zero = EncChannel {
        ephemeral_pubkey: Zero::zero(),
        enc_channel_key: Zero::zero(),
        enc_token: Zero::zero(),
        enc_sender_addr: Zero::zero(),
    };
    assert_eq!(enc_channel_zero.is_non_zero(), false);
}
