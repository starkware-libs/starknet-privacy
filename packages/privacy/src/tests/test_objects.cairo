use core::num::traits::Zero;
use privacy::objects::{
    EncChannelInfo, EncChannelInfoTrait, EncSubchannelInfo, Note, NoteTrait, TokenBalances,
    TokenBalancesTrait,
};
use privacy::tests::utils_for_tests::{Test, TestTrait, UserTrait, constants};
use privacy::utils::encrypt_note_amount;
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

#[test]
fn test_note_encrypt_decrypt() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_address = test.mock_new_token();
    let amount = constants::DEFAULT_AMOUNT;
    let salt = user.get_salt();
    let channel_key = user.compute_channel_key(recipient: user);
    let index = 0;

    let note = NoteTrait::encrypt(:channel_key, token: token_address, :index, :salt, :amount);
    let expected_note = Note {
        enc_value: encrypt_note_amount(:channel_key, token: token_address, :index, :salt, :amount),
        token: Zero::zero(),
    };
    assert_eq!(note, expected_note);
    assert_eq!(note.decrypt(:channel_key, token: token_address, :index), amount);
}

#[test]
fn test_note_zero() {
    let mut test: Test = Default::default();
    let token = test.mock_new_token();
    let enc_value = test.mock_new_note(amount: constants::DEFAULT_AMOUNT).enc_amount;

    assert_eq!(Zero::zero(), Note { enc_value: Zero::zero(), token: Zero::zero() });
    assert!(Note { enc_value, token: Zero::zero() }.is_non_zero());
    assert!(Note { enc_value: Zero::zero(), token }.is_non_zero());
}
