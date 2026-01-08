use core::num::traits::Zero;
use privacy::objects::{
    EncChannelInfo, EncChannelInfoTrait, EncSubchannelInfo, TokenBalances, TokenBalancesTrait,
};
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
