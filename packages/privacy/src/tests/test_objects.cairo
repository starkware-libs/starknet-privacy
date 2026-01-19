use core::num::traits::Zero;
use privacy::actions::{ServerAction, WriteIfZeroInput};
use privacy::objects::{
    EncChannelInfo, EncChannelInfoTrait, EncOutgoingChannelInfo, EncOutgoingChannelInfoTrait,
    EncPrivateKey, EncPrivateKeyTrait, EncSubchannelInfo, EncSubchannelInfoTrait, TokenBalances,
    TokenBalancesTrait,
};
use snforge_std::map_entry_address;
use starknet::ContractAddress;

#[test]
fn test_enc_channel_info_is_non_zero() {
    let mut enc_channel_info = EncChannelInfo {
        ephemeral_pubkey: 'EPHEMERAL_PUBKEY'.try_into().unwrap(),
        enc_channel_key: 'ENC_CHANNEL_KEY'.try_into().unwrap(),
        enc_sender_addr: 'ENC_SENDER_ADDR'.try_into().unwrap(),
    };
    assert_eq!(enc_channel_info.is_non_zero(), true);
    enc_channel_info.ephemeral_pubkey = Zero::zero();
    assert_eq!(enc_channel_info.is_non_zero(), false);
    enc_channel_info.ephemeral_pubkey = 'EPHEMERAL_PUBKEY'.try_into().unwrap();
    enc_channel_info.enc_channel_key = Zero::zero();
    assert_eq!(enc_channel_info.is_non_zero(), false);
    enc_channel_info.enc_channel_key = 'ENC_CHANNEL_KEY'.try_into().unwrap();
    enc_channel_info.enc_sender_addr = Zero::zero();
    assert_eq!(enc_channel_info.is_non_zero(), false);
    let enc_channel_info_zero = EncChannelInfo {
        ephemeral_pubkey: Zero::zero(),
        enc_channel_key: Zero::zero(),
        enc_sender_addr: Zero::zero(),
    };
    assert_eq!(enc_channel_info_zero.is_non_zero(), false);
}

#[test]
fn test_enc_subchannel_info_zero() {
    let enc_subchannel_info_zero: EncSubchannelInfo = Zero::zero();
    assert_eq!(enc_subchannel_info_zero.is_zero(), true);
    assert_eq!(enc_subchannel_info_zero.is_non_zero(), false);
    assert_eq!(
        enc_subchannel_info_zero, EncSubchannelInfo { salt: Zero::zero(), enc_token: Zero::zero() },
    );
}

#[test]
fn test_enc_subchannel_info_is_zero() {
    let mut enc_subchannel_info = EncSubchannelInfo {
        salt: 'SALT'.try_into().unwrap(), enc_token: 'ENC_TOKEN'.try_into().unwrap(),
    };
    assert_eq!(enc_subchannel_info.is_zero(), false);
    enc_subchannel_info.salt = Zero::zero();
    assert_eq!(enc_subchannel_info.is_zero(), false);
    enc_subchannel_info.salt = 'SALT'.try_into().unwrap();
    enc_subchannel_info.enc_token = Zero::zero();
    assert_eq!(enc_subchannel_info.is_zero(), true);
    enc_subchannel_info.salt = Zero::zero();
    assert_eq!(enc_subchannel_info.is_zero(), true);
}

#[test]
fn test_enc_subchannel_info_is_non_zero() {
    let mut enc_subchannel_info = EncSubchannelInfo {
        salt: 'SALT'.try_into().unwrap(), enc_token: 'ENC_TOKEN'.try_into().unwrap(),
    };
    assert_eq!(enc_subchannel_info.is_non_zero(), true);
    enc_subchannel_info.salt = Zero::zero();
    assert_eq!(enc_subchannel_info.is_non_zero(), true);
    enc_subchannel_info.salt = 'SALT'.try_into().unwrap();
    enc_subchannel_info.enc_token = Zero::zero();
    assert_eq!(enc_subchannel_info.is_non_zero(), false);
    enc_subchannel_info.salt = Zero::zero();
    assert_eq!(enc_subchannel_info.is_non_zero(), false);
}

#[test]
fn test_enc_outgoing_channel_info_zero() {
    let enc_outgoing_channel_info_zero: EncOutgoingChannelInfo = Zero::zero();
    assert_eq!(enc_outgoing_channel_info_zero.is_zero(), true);
    assert_eq!(enc_outgoing_channel_info_zero.is_non_zero(), false);
    assert_eq!(
        enc_outgoing_channel_info_zero,
        EncOutgoingChannelInfo { salt: Zero::zero(), enc_recipient_addr: Zero::zero() },
    );
}

#[test]
fn test_enc_outgoing_channel_info_is_zero() {
    let mut enc_outgoing_channel_info = EncOutgoingChannelInfo {
        salt: 'salt'.try_into().unwrap(),
        enc_recipient_addr: 'ENC_RECIPIENT_ADDR'.try_into().unwrap(),
    };
    assert_eq!(enc_outgoing_channel_info.is_zero(), false);
    enc_outgoing_channel_info.salt = Zero::zero();
    assert_eq!(enc_outgoing_channel_info.is_zero(), false);
    enc_outgoing_channel_info.salt = 'salt'.try_into().unwrap();
    enc_outgoing_channel_info.enc_recipient_addr = Zero::zero();
    assert_eq!(enc_outgoing_channel_info.is_zero(), true);
    enc_outgoing_channel_info.salt = Zero::zero();
    assert_eq!(enc_outgoing_channel_info.is_zero(), true);
}

#[test]
fn test_enc_outgoing_channel_info_is_non_zero() {
    let mut enc_outgoing_channel_info = EncOutgoingChannelInfo {
        salt: 'salt'.try_into().unwrap(),
        enc_recipient_addr: 'ENC_RECIPIENT_ADDR'.try_into().unwrap(),
    };
    assert_eq!(enc_outgoing_channel_info.is_non_zero(), true);
    enc_outgoing_channel_info.salt = Zero::zero();
    assert_eq!(enc_outgoing_channel_info.is_non_zero(), true);
    enc_outgoing_channel_info.salt = 'salt'.try_into().unwrap();
    enc_outgoing_channel_info.enc_recipient_addr = Zero::zero();
    assert_eq!(enc_outgoing_channel_info.is_non_zero(), false);
    enc_outgoing_channel_info.salt = Zero::zero();
    assert_eq!(enc_outgoing_channel_info.is_non_zero(), false);
}

#[test]
fn test_token_balances() {
    let token_1: ContractAddress = 'TOKEN_1'.try_into().unwrap();
    let token_2: ContractAddress = 'TOKEN_2'.try_into().unwrap();
    let mut token_balances: TokenBalances = Default::default();

    // Add balance.
    token_balances.add_balance(token: token_1, amount: 1);
    token_balances.add_balance(token: token_2, amount: 2);

    // Subtract balance.
    token_balances.subtract_balance(token: token_1, amount: 1);
    token_balances.subtract_balance(token: token_2, amount: 2);

    // Assert valid.
    token_balances.squash().assert_valid();
}

#[test]
fn test_token_balances_assert_valid_empty() {
    let token_balances: TokenBalances = Default::default();
    token_balances.squash().assert_valid();
}

#[test]
#[should_panic(expected_error: 'NEGATIVE_INTERMEDIATE_BALANCE')]
fn test_token_balances_negative_intermediate_balance_from_zero() {
    let token = 'TOKEN'.try_into().unwrap();
    let mut token_balances: TokenBalances = Default::default();
    token_balances.subtract_balance(token: token, amount: 1);
}

#[test]
#[should_panic(expected_error: 'NEGATIVE_INTERMEDIATE_BALANCE')]
fn test_token_balances_negative_intermediate_balance() {
    let token = 'TOKEN'.try_into().unwrap();
    let mut token_balances: TokenBalances = Default::default();
    token_balances.add_balance(token: token, amount: 1);
    token_balances.subtract_balance(token: token, amount: 2);
}

#[test]
#[should_panic(expected_error: 'FINAL_BALANCE_MUST_BE_ZERO')]
fn test_token_balances_final_balance_must_be_zero() {
    let token_1: ContractAddress = 'TOKEN_1'.try_into().unwrap();
    let token_2: ContractAddress = 'TOKEN_2'.try_into().unwrap();
    let mut token_balances: TokenBalances = Default::default();

    // Add balance.
    token_balances.add_balance(token: token_1, amount: 1);
    token_balances.add_balance(token: token_2, amount: 2);

    // Subtract balance.
    token_balances.subtract_balance(token: token_1, amount: 1);
    token_balances.subtract_balance(token: token_2, amount: 1);

    token_balances.squash().assert_valid();
}

#[test]
fn test_enc_private_key_to_write_if_zero_actions() {
    let ephemeral_pubkey = 'EPHEMERAL_PUBKEY';
    let enc_private_key = 'ENC_PRIVATE_KEY';
    let enc_private_key_obj = EncPrivateKey { ephemeral_pubkey, enc_private_key };
    let key = 'KEY';
    let base_storage_address = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [key].span(),
    );
    let actions = enc_private_key_obj.to_write_if_zero_actions(:base_storage_address).span();
    assert_eq!(
        actions,
        [
            ServerAction::WriteIfZero(
                WriteIfZeroInput { storage_address: base_storage_address, value: ephemeral_pubkey },
            ),
            ServerAction::WriteIfZero(
                WriteIfZeroInput {
                    storage_address: base_storage_address + 1, value: enc_private_key,
                },
            ),
        ]
            .span(),
    );
}

#[test]
fn test_enc_subchannel_info_to_write_if_zero_actions() {
    let salt = 'SALT';
    let enc_token = 'ENC_TOKEN';
    let enc_subchannel_info = EncSubchannelInfo { salt, enc_token };
    let key = 'KEY';
    let base_storage_address = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [key].span(),
    );
    let actions = enc_subchannel_info.to_write_if_zero_actions(:base_storage_address).span();
    assert_eq!(
        actions,
        [
            ServerAction::WriteIfZero(
                WriteIfZeroInput { storage_address: base_storage_address, value: salt },
            ),
            ServerAction::WriteIfZero(
                WriteIfZeroInput { storage_address: base_storage_address + 1, value: enc_token },
            ),
        ]
            .span(),
    );
}

#[test]
fn test_enc_outgoing_channel_info_to_write_if_zero_actions() {
    let salt = 'SALT';
    let enc_recipient_addr = 'ENC_RECIPIENT_ADDR';
    let enc_outgoing_channel_info = EncOutgoingChannelInfo { salt, enc_recipient_addr };
    let key = 'KEY';
    let base_storage_address = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [key].span(),
    );
    let actions = enc_outgoing_channel_info.to_write_if_zero_actions(:base_storage_address).span();
    assert_eq!(
        actions,
        [
            ServerAction::WriteIfZero(
                WriteIfZeroInput { storage_address: base_storage_address, value: salt },
            ),
            ServerAction::WriteIfZero(
                WriteIfZeroInput {
                    storage_address: base_storage_address + 1, value: enc_recipient_addr,
                },
            ),
        ]
            .span(),
    );
}
