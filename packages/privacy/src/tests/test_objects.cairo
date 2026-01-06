use core::num::traits::Zero;
use privacy::objects::{
    BalanceOp, EncChannelInfo, EncChannelInfoTrait, EncSubchannelInfo, TokenBalances,
    TokenBalancesTrait,
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
        enc_subchannel_info_zero,
        EncSubchannelInfo { random: Zero::zero(), enc_token: Zero::zero() },
    );
}

#[test]
fn test_enc_subchannel_info_is_zero() {
    let mut enc_subchannel_info = EncSubchannelInfo {
        random: 'RANDOM'.try_into().unwrap(), enc_token: 'ENC_TOKEN'.try_into().unwrap(),
    };
    assert_eq!(enc_subchannel_info.is_zero(), false);
    enc_subchannel_info.random = Zero::zero();
    assert_eq!(enc_subchannel_info.is_zero(), true);
    enc_subchannel_info.random = 'RANDOM'.try_into().unwrap();
    enc_subchannel_info.enc_token = Zero::zero();
    assert_eq!(enc_subchannel_info.is_zero(), true);
    enc_subchannel_info.random = Zero::zero();
    assert_eq!(enc_subchannel_info.is_zero(), true);
}

#[test]
fn test_enc_subchannel_info_is_non_zero() {
    let mut enc_subchannel_info = EncSubchannelInfo {
        random: 'RANDOM'.try_into().unwrap(), enc_token: 'ENC_TOKEN'.try_into().unwrap(),
    };
    assert_eq!(enc_subchannel_info.is_non_zero(), true);
    enc_subchannel_info.random = Zero::zero();
    assert_eq!(enc_subchannel_info.is_non_zero(), false);
    enc_subchannel_info.random = 'RANDOM'.try_into().unwrap();
    enc_subchannel_info.enc_token = Zero::zero();
    assert_eq!(enc_subchannel_info.is_non_zero(), false);
    enc_subchannel_info.random = Zero::zero();
    assert_eq!(enc_subchannel_info.is_non_zero(), false);
}

#[test]
fn test_token_balances() {
    let token_1: ContractAddress = 'TOKEN_1'.try_into().unwrap();
    let token_2: ContractAddress = 'TOKEN_2'.try_into().unwrap();
    let mut token_balances: TokenBalances = Default::default();
    // (0, 0)
    assert_eq!(token_balances.is_valid(), true);

    // (1, 0)
    token_balances.modify_balance(token: token_1, op: BalanceOp::ADDITION, amount: 1);
    assert_eq!(token_balances.is_valid(), false);

    // (0, 0)
    token_balances.modify_balance(token: token_1, op: BalanceOp::SUBTRACTION, amount: 1);
    assert_eq!(token_balances.is_valid(), true);

    // (0, 2)
    token_balances.modify_balance(token: token_2, op: BalanceOp::ADDITION, amount: 2);
    assert_eq!(token_balances.is_valid(), false);

    // (1, 2)
    token_balances.modify_balance(token: token_1, op: BalanceOp::ADDITION, amount: 1);
    assert_eq!(token_balances.is_valid(), false);

    // (1, 1)
    token_balances.modify_balance(token: token_2, op: BalanceOp::SUBTRACTION, amount: 1);
    assert_eq!(token_balances.is_valid(), false);

    // (0, 1)
    token_balances.modify_balance(token: token_1, op: BalanceOp::SUBTRACTION, amount: 1);
    assert_eq!(token_balances.is_valid(), false);

    // (0, 0)
    token_balances.modify_balance(token: token_2, op: BalanceOp::SUBTRACTION, amount: 1);
    assert_eq!(token_balances.is_valid(), true);
}

#[test]
#[should_panic(expected_error: 'u128_sub Overflow')]
fn test_token_balances_underflow() {
    let token = 'TOKEN'.try_into().unwrap();
    let mut token_balances: TokenBalances = Default::default();
    token_balances.modify_balance(:token, op: BalanceOp::SUBTRACTION, amount: 1);
    token_balances.is_valid();
}
