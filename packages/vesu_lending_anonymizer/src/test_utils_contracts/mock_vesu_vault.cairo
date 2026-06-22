/// Mock Vesu vault for testing deposit/redeem. Implements 1:1 asset/share exchange.
/// Must be pre-funded with underlying_token (for redeem).
#[starknet::contract]
pub mod MockVesuVault {
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use vesu_lending_anonymizer::vesu_lending_anonymizer::IVToken;

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
    impl MockVesuVaultImpl of IVToken<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            IERC20Dispatcher { contract_address: self.underlying_token.read() }
                .transfer_from(
                    sender: get_caller_address(), recipient: get_contract_address(), amount: assets,
                );
            self.erc20.mint(recipient: receiver, amount: assets);
            assets
        }

        fn redeem(
            ref self: ContractState,
            shares: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            self.erc20.burn(account: owner, amount: shares);
            IERC20Dispatcher { contract_address: self.underlying_token.read() }
                .transfer(recipient: receiver, amount: shares);
            shares
        }
    }
}

/// Mock Vesu vault that returns zero tokens. Implements same interface for zero-out-amount tests.
#[starknet::contract]
pub mod MockVesuVaultNoop {
    use core::num::traits::Zero;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;
    use starknet::storage::StoragePointerWriteAccess;
    use vesu_lending_anonymizer::vesu_lending_anonymizer::IVToken;

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
    impl MockVesuVaultImpl of IVToken<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            Zero::zero()
        }

        fn redeem(
            ref self: ContractState,
            shares: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            Zero::zero()
        }
    }
}

/// Mock Vesu vault that returns amount exceeding u128::MAX. Implements same interface for overflow
/// tests.
#[starknet::contract]
pub mod MockVesuVaultOverflow {
    use core::num::traits::Zero;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starkware_utils::constants::MAX_U128;
    use vesu_lending_anonymizer::vesu_lending_anonymizer::IVToken;

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
    impl MockVesuVaultImpl of IVToken<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            let overflow_amount: u256 = MAX_U128.into() + 1;
            self.erc20.mint(recipient: receiver, amount: overflow_amount);
            overflow_amount
        }

        fn redeem(
            ref self: ContractState,
            shares: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            let overflow_amount: u256 = MAX_U128.into() + 1;
            IERC20Dispatcher { contract_address: self.underlying_token.read() }
                .transfer(recipient: receiver, amount: overflow_amount);
            Zero::zero()
        }
    }
}

/// Mock Vesu vault modeling accrued interest at a 2:1 share→asset rate. `deposit` mints one share
/// per underlying asset; `redeem` burns the exact share count and pays out twice as many underlying
/// assets (so the vault must be pre-funded with the extra underlying). Used to verify the
/// anonymizer redeems an exact share count instead of treating the amount as underlying.
#[starknet::contract]
pub mod MockVesuVaultInterest {
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use vesu_lending_anonymizer::vesu_lending_anonymizer::IVToken;

    /// Underlying assets paid out per share on redeem.
    const REDEEM_RATE: u256 = 2;

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
    impl MockVesuVaultImpl of IVToken<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            IERC20Dispatcher { contract_address: self.underlying_token.read() }
                .transfer_from(
                    sender: get_caller_address(), recipient: get_contract_address(), amount: assets,
                );
            self.erc20.mint(recipient: receiver, amount: assets);
            assets
        }

        fn redeem(
            ref self: ContractState,
            shares: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            self.erc20.burn(account: owner, amount: shares);
            let assets = shares * REDEEM_RATE;
            IERC20Dispatcher { contract_address: self.underlying_token.read() }
                .transfer(recipient: receiver, amount: assets);
            assets
        }
    }
}
