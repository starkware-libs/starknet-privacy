/// Mock Endur ERC-4626 vault for testing deposits. Implements 1:1 asset/share exchange.
#[starknet::contract]
pub mod MockEndurVault {
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use endur_deposit_anonymizer::endur_deposit_anonymizer::IERC4626;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    #[abi(embed_v0)]
    impl ERC20CamelOnlyImpl = ERC20Component::ERC20CamelOnlyImpl<ContractState>;
    impl InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        underlying_token: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: ByteArray,
        symbol: ByteArray,
        underlying_token: ContractAddress,
    ) {
        self.erc20.initializer(name, symbol);
        self.underlying_token.write(underlying_token);
    }

    #[abi(embed_v0)]
    impl MockEndurVaultImpl of IERC4626<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            IERC20Dispatcher { contract_address: self.underlying_token.read() }
                .transfer_from(
                    sender: get_caller_address(), recipient: get_contract_address(), amount: assets,
                );
            self.erc20.mint(recipient: receiver, amount: assets);
            assets
        }
    }
}

/// Mock Endur vault that returns zero LST shares.
#[starknet::contract]
pub mod MockEndurVaultNoop {
    use core::num::traits::Zero;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;
    use starknet::storage::StoragePointerWriteAccess;
    use endur_deposit_anonymizer::endur_deposit_anonymizer::IERC4626;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    #[abi(embed_v0)]
    impl ERC20CamelOnlyImpl = ERC20Component::ERC20CamelOnlyImpl<ContractState>;
    impl InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        underlying_token: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: ByteArray,
        symbol: ByteArray,
        underlying_token: ContractAddress,
    ) {
        self.erc20.initializer(name, symbol);
        self.underlying_token.write(underlying_token);
    }

    #[abi(embed_v0)]
    impl MockEndurVaultImpl of IERC4626<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            Zero::zero()
        }
    }
}

/// Mock Endur vault that mints LST shares exceeding u128::MAX.
#[starknet::contract]
pub mod MockEndurVaultOverflow {
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;
    use starknet::storage::StoragePointerWriteAccess;
    use starkware_utils::constants::MAX_U128;
    use endur_deposit_anonymizer::endur_deposit_anonymizer::IERC4626;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    #[abi(embed_v0)]
    impl ERC20CamelOnlyImpl = ERC20Component::ERC20CamelOnlyImpl<ContractState>;
    impl InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        underlying_token: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: ByteArray,
        symbol: ByteArray,
        underlying_token: ContractAddress,
    ) {
        self.erc20.initializer(name, symbol);
        self.underlying_token.write(underlying_token);
    }

    #[abi(embed_v0)]
    impl MockEndurVaultImpl of IERC4626<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            let overflow_amount: u256 = MAX_U128.into() + 1;
            self.erc20.mint(recipient: receiver, amount: overflow_amount);
            overflow_amount
        }
    }
}
