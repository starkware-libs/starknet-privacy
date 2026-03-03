/// Minimal ERC-20 with dual-case interface (snake_case + camelCase) for Ekubo
/// compatibility, plus an open `permissioned_mint` for test seeding.
#[starknet::contract]
pub mod TestToken {
    use openzeppelin_token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20MixinImpl = ERC20Component::ERC20MixinImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, name: ByteArray, symbol: ByteArray) {
        self.erc20.initializer(name, symbol);
    }

    #[external(v0)]
    fn permissioned_mint(
        ref self: ContractState, account: ContractAddress, amount: u256,
    ) {
        self.erc20.mint(account, amount);
    }

    #[external(v0)]
    fn permissionedMint(
        ref self: ContractState, account: ContractAddress, amount: u256,
    ) {
        self.erc20.mint(account, amount);
    }
}
