use privacy::actions::{ServerAction, WriteOnceInput};
use privacy::objects::{
    EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo, Note, TokenBalances,
    TokenBalancesTrait,
};
use privacy::tests::test_objects::MockContract::deploy_for_test as deploy_mock_contract_for_test;
use privacy::utils::to_write_once_action;
use snforge_std::{DeclareResultTrait, declare, map_entry_address};
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};


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
#[should_panic(expected: 'NEGATIVE_INTERMEDIATE_BALANCE')]
fn test_token_balances_negative_intermediate_balance_from_zero() {
    let token = 'TOKEN'.try_into().unwrap();
    let mut token_balances: TokenBalances = Default::default();
    token_balances.subtract_balance(:token, amount: 1);
}

#[test]
#[should_panic(expected: 'NEGATIVE_INTERMEDIATE_BALANCE')]
fn test_token_balances_negative_intermediate_balance() {
    let token = 'TOKEN'.try_into().unwrap();
    let mut token_balances: TokenBalances = Default::default();
    token_balances.add_balance(:token, amount: 1);
    token_balances.subtract_balance(:token, amount: 2);
}

#[test]
#[should_panic(expected: 'FINAL_BALANCE_MUST_BE_ZERO')]
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
fn test_enc_private_key_to_write_once_action() {
    let auditor_public_key = 'AUDITOR_PUBLIC_KEY';
    let ephemeral_pubkey = 'EPHEMERAL_PUBKEY';
    let enc_private_key = 'ENC_PRIVATE_KEY';
    let enc_private_key_obj = EncPrivateKey {
        auditor_public_key, ephemeral_pubkey, enc_private_key,
    };
    let key = 'KEY';
    let storage_address = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [key].span(),
    );
    let action = to_write_once_action(:storage_address, value: enc_private_key_obj);
    assert_eq!(
        action,
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address,
                value: [auditor_public_key, ephemeral_pubkey, enc_private_key].span(),
            },
        ),
    );
}

#[test]
fn test_enc_subchannel_info_to_write_once_action() {
    let salt = 'SALT';
    let enc_token = 'ENC_TOKEN';
    let enc_subchannel_info = EncSubchannelInfo { salt, enc_token };
    let key = 'KEY';
    let storage_address = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [key].span(),
    );
    let action = to_write_once_action(:storage_address, value: enc_subchannel_info);
    assert_eq!(
        action,
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address, value: [salt, enc_token].span() },
        ),
    );
}

#[test]
fn test_enc_outgoing_channel_info_to_write_once_action() {
    let salt = 'SALT';
    let enc_recipient_addr = 'ENC_RECIPIENT_ADDR';
    let enc_outgoing_channel_info = EncOutgoingChannelInfo { salt, enc_recipient_addr };
    let key = 'KEY';
    let storage_address = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [key].span(),
    );
    let action = to_write_once_action(:storage_address, value: enc_outgoing_channel_info);
    assert_eq!(
        action,
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address, value: [salt, enc_recipient_addr].span() },
        ),
    );
}

#[test]
fn test_note_to_write_once_action() {
    let enc_value = 'ENC_VALUE';
    let token: ContractAddress = 'TOKEN'.try_into().unwrap();
    let depositor: ContractAddress = 'DEPOSITOR'.try_into().unwrap();
    let note = Note { packed_value: enc_value, token, depositor };
    let key = 'KEY';
    let storage_address = map_entry_address(map_selector: selector!("notes"), keys: [key].span());
    let action = to_write_once_action(:storage_address, value: note);
    assert_eq!(
        action,
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address, value: [enc_value, token.into(), depositor.into()].span(),
            },
        ),
    );
}

#[test]
fn test_bool_to_write_once_action() {
    let key = 'KEY';
    let storage_address = map_entry_address(map_selector: selector!("bool"), keys: [key].span());
    let action = to_write_once_action(:storage_address, value: true);
    assert_eq!(
        action,
        ServerAction::WriteOnce(WriteOnceInput { storage_address, value: [true.into()].span() }),
    );
    let action = to_write_once_action(:storage_address, value: false);
    assert_eq!(
        action,
        ServerAction::WriteOnce(WriteOnceInput { storage_address, value: [false.into()].span() }),
    );
}

/// Interface for `MockContract`.
#[starknet::interface]
trait IMockContract<T> {
    fn get_enc_private_key(self: @T) -> EncPrivateKey;
    fn get_enc_subchannel_info(self: @T) -> EncSubchannelInfo;
    fn get_enc_outgoing_channel_info(self: @T) -> EncOutgoingChannelInfo;
    fn get_note(self: @T) -> Note;
    fn get_felt(self: @T) -> felt252;
    fn get_bool(self: @T) -> bool;
    fn write_serialized_enc_private_key(ref self: T, serialized_value: Span<felt252>);
    fn write_serialized_enc_subchannel_info(ref self: T, serialized_value: Span<felt252>);
    fn write_serialized_enc_outgoing_channel_info(ref self: T, serialized_value: Span<felt252>);
    fn write_serialized_note(ref self: T, serialized_value: Span<felt252>);
    fn write_serialized_felt(ref self: T, serialized_value: Span<felt252>);
    fn write_serialized_bool(ref self: T, serialized_value: Span<felt252>);
}

/// Mock contract to test serialization format exactly matches in-storage representation for
/// structs: EncPrivateKey, EncSubchannelInfo, EncOutgoingChannelInfo.
#[starknet::contract]
mod MockContract {
    use privacy::objects::{EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo, Note};
    use privacy::tests::test_objects::IMockContract;
    use starknet::SyscallResultTrait;
    use starknet::storage::StoragePointerReadAccess;
    use starknet::storage_access::{
        storage_address_from_base_and_offset, storage_base_address_from_felt252,
    };
    use starknet::syscalls::storage_write_syscall;

    #[storage]
    struct Storage {
        enc_private_key: EncPrivateKey,
        enc_subchannel_info: EncSubchannelInfo,
        enc_outgoing_channel_info: EncOutgoingChannelInfo,
        note: Note,
        felt: felt252,
        boolean: bool,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl MockContractViewsImpl of IMockContract<ContractState> {
        fn get_enc_private_key(self: @ContractState) -> EncPrivateKey {
            self.enc_private_key.read()
        }
        fn get_enc_subchannel_info(self: @ContractState) -> EncSubchannelInfo {
            self.enc_subchannel_info.read()
        }
        fn get_enc_outgoing_channel_info(self: @ContractState) -> EncOutgoingChannelInfo {
            self.enc_outgoing_channel_info.read()
        }
        fn get_note(self: @ContractState) -> Note {
            self.note.read()
        }
        fn get_felt(self: @ContractState) -> felt252 {
            self.felt.read()
        }
        fn get_bool(self: @ContractState) -> bool {
            self.boolean.read()
        }
        fn write_serialized_enc_private_key(
            ref self: ContractState, serialized_value: Span<felt252>,
        ) {
            let storage_address = self.enc_private_key.__base_address__;
            self._write(:storage_address, :serialized_value);
        }
        fn write_serialized_enc_subchannel_info(
            ref self: ContractState, serialized_value: Span<felt252>,
        ) {
            let storage_address = self.enc_subchannel_info.__base_address__;
            self._write(:storage_address, :serialized_value);
        }
        fn write_serialized_enc_outgoing_channel_info(
            ref self: ContractState, serialized_value: Span<felt252>,
        ) {
            let storage_address = self.enc_outgoing_channel_info.__base_address__;
            self._write(:storage_address, :serialized_value);
        }
        fn write_serialized_note(ref self: ContractState, serialized_value: Span<felt252>) {
            let storage_address = self.note.__base_address__;
            self._write(:storage_address, :serialized_value);
        }
        fn write_serialized_felt(ref self: ContractState, serialized_value: Span<felt252>) {
            assert(serialized_value.len() == 1, 'EXPECTED_LENGTH_1');
            let storage_address = self.felt.__base_address__;
            self._write(:storage_address, :serialized_value);
        }
        fn write_serialized_bool(ref self: ContractState, serialized_value: Span<felt252>) {
            assert(serialized_value.len() == 1, 'EXPECTED_LENGTH_1');
            let storage_address = self.boolean.__base_address__;
            self._write(:storage_address, :serialized_value);
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _write(
            ref self: ContractState, storage_address: felt252, serialized_value: Span<felt252>,
        ) {
            let len = serialized_value.len();
            assert(len >= 1 && len <= 3, 'EXPECTED_LENGTH_1_TO_3');
            let base = storage_base_address_from_felt252(addr: storage_address);
            let addr_0 = storage_address_from_base_and_offset(:base, offset: 0);
            storage_write_syscall(address_domain: 0, address: addr_0, value: *serialized_value[0])
                .unwrap_syscall();
            if len >= 2 {
                let addr_1 = storage_address_from_base_and_offset(:base, offset: 1);
                storage_write_syscall(
                    address_domain: 0, address: addr_1, value: *serialized_value[1],
                )
                    .unwrap_syscall();
            }
            if len == 3 {
                let addr_2 = storage_address_from_base_and_offset(:base, offset: 2);
                storage_write_syscall(
                    address_domain: 0, address: addr_2, value: *serialized_value[2],
                )
                    .unwrap_syscall();
            }
        }
    }
}

fn deploy_mock_contract() -> ContractAddress {
    let class_hash = *declare(contract: "MockContract")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (mock_contract_address, _) = deploy_mock_contract_for_test(:class_hash, :deployment_params)
        .expect('MockContract deployment failed');
    mock_contract_address
}

#[test]
fn enc_private_key_serialization_format() {
    let mock_contract_address = deploy_mock_contract();
    let mock_contract = IMockContractDispatcher { contract_address: mock_contract_address };
    let enc_private_key = EncPrivateKey {
        auditor_public_key: 'AUDITOR_PUBLIC_KEY',
        ephemeral_pubkey: 'EPHEMERAL_PUBKEY',
        enc_private_key: 'ENC_PRIVATE_KEY',
    };
    let mut serialized_value = array![];
    enc_private_key.serialize(ref output: serialized_value);
    mock_contract.write_serialized_enc_private_key(serialized_value: serialized_value.span());
    assert_eq!(mock_contract.get_enc_private_key(), enc_private_key);
}

#[test]
fn enc_subchannel_info_serialization_format() {
    let mock_contract_address = deploy_mock_contract();
    let mock_contract = IMockContractDispatcher { contract_address: mock_contract_address };
    let enc_subchannel_info = EncSubchannelInfo {
        salt: 'SALT'.try_into().unwrap(), enc_token: 'ENC_TOKEN'.try_into().unwrap(),
    };
    let mut serialized_value = array![];
    enc_subchannel_info.serialize(ref output: serialized_value);
    mock_contract.write_serialized_enc_subchannel_info(serialized_value: serialized_value.span());
    assert_eq!(mock_contract.get_enc_subchannel_info(), enc_subchannel_info);
}

#[test]
fn enc_outgoing_channel_info_serialization_format() {
    let mock_contract_address = deploy_mock_contract();
    let mock_contract = IMockContractDispatcher { contract_address: mock_contract_address };
    let enc_outgoing_channel_info = EncOutgoingChannelInfo {
        salt: 'SALT'.try_into().unwrap(),
        enc_recipient_addr: 'ENC_RECIPIENT_ADDR'.try_into().unwrap(),
    };
    let mut serialized_value = array![];
    enc_outgoing_channel_info.serialize(ref output: serialized_value);
    mock_contract
        .write_serialized_enc_outgoing_channel_info(serialized_value: serialized_value.span());
    assert_eq!(mock_contract.get_enc_outgoing_channel_info(), enc_outgoing_channel_info);
}

#[test]
fn note_serialization_format() {
    let mock_contract_address = deploy_mock_contract();
    let mock_contract = IMockContractDispatcher { contract_address: mock_contract_address };
    let note = Note {
        packed_value: 'ENC_VALUE',
        token: 'TOKEN'.try_into().unwrap(),
        depositor: 'DEPOSITOR'.try_into().unwrap(),
    };
    let mut serialized_value = array![];
    note.serialize(ref output: serialized_value);
    mock_contract.write_serialized_note(serialized_value: serialized_value.span());
    assert_eq!(mock_contract.get_note(), note);
}

#[test]
fn felt_serialization_format() {
    let mock_contract_address = deploy_mock_contract();
    let mock_contract = IMockContractDispatcher { contract_address: mock_contract_address };
    let felt = 'FELT';
    let mut serialized_value = array![];
    felt.serialize(ref output: serialized_value);
    mock_contract.write_serialized_felt(serialized_value: serialized_value.span());
    assert_eq!(mock_contract.get_felt(), felt);
}

#[test]
fn bool_serialization_format() {
    let mock_contract_address = deploy_mock_contract();
    let mock_contract = IMockContractDispatcher { contract_address: mock_contract_address };
    let boolean = true;
    let mut serialized_value = array![];
    boolean.serialize(ref output: serialized_value);
    mock_contract.write_serialized_bool(serialized_value: serialized_value.span());
    assert_eq!(mock_contract.get_bool(), boolean);
    let boolean = false;
    serialized_value = array![];
    boolean.serialize(ref output: serialized_value);
    mock_contract.write_serialized_bool(serialized_value: serialized_value.span());
    assert_eq!(mock_contract.get_bool(), boolean);
}
