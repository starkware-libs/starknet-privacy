/// Mock ForgeYields TokenGateway for unit tests. Pass-through 1:1 — no pps math.
///
/// In the real protocol, redemption NFTs are minted on a separate `RedeemRequest`
/// ERC-721 contract referenced via `gateway.redeem_request()`. For unit-test
/// simplicity the mock plays both roles: `redeem_request()` returns the gateway's
/// own address, and `owner_of(id)` reverts on burned (= claimed) ids so the
/// anonymizer's SafeDispatcher detection works.
///
/// Public-on-gateway: `request_redeem`, `claim_redeem` (callable by anyone),
///                    `redeem_request`, `due_assets_from_id`, `owner_of`.
#[starknet::contract]
pub mod MockForgeGateway {
    use core::num::traits::Zero;
    use forge_yields_anonymizer::forge_yields_anonymizer::{IForgeTokenGateway, IRedeemRequestNft};
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address};

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
        next_id: u256,
        /// id -> owner (zero = burned/never existed).
        nft_owner: Map<u256, ContractAddress>,
        /// id -> shares pending (also = due assets in this 1:1 mock). Persists post-burn
        /// to mirror real `id_to_info` which is preserved across claim.
        shares_by_id: Map<u256, u256>,
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
        self.next_id.write(1);
    }

    #[abi(embed_v0)]
    impl MockForgeGatewayImpl of IForgeTokenGateway<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            IERC20Dispatcher { contract_address: self.underlying_token.read() }
                .transfer_from(
                    sender: get_caller_address(), recipient: get_contract_address(), amount: assets,
                );
            self.erc20.mint(recipient: receiver, amount: assets);
            assets
        }

        fn request_redeem(
            ref self: ContractState,
            shares: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            self.erc20.burn(account: owner, amount: shares);
            let id = self.next_id.read();
            self.next_id.write(id + 1);
            self.nft_owner.write(id, receiver);
            self.shares_by_id.write(id, shares);
            id
        }

        /// NFT contract is the gateway itself in this mock.
        fn redeem_request(self: @ContractState) -> ContractAddress {
            get_contract_address()
        }

        /// 1:1 ratio, no pps. Returns the stored shares amount whether the NFT is alive
        /// or burned (persists post-burn, mirroring real `id_to_info`).
        fn due_assets_from_id(self: @ContractState, id: u256) -> u256 {
            self.shares_by_id.read(id)
        }

        /// Permissionless. Burns the NFT and pays out to `owner_of(id)`. The anonymizer
        /// calls this opportunistically when the NFT is still alive; otherwise some
        /// external party (auto-service, bot) has already called it.
        fn claim_redeem(ref self: ContractState, id: u256) -> u256 {
            let owner = self.nft_owner.read(id);
            assert(owner.is_non_zero(), 'CLAIM_UNKNOWN_OR_CLAIMED');
            let shares = self.shares_by_id.read(id);
            self.nft_owner.write(id, Zero::zero()); // "burn" the NFT
            IERC20Dispatcher { contract_address: self.underlying_token.read() }
                .transfer(recipient: owner, amount: shares);
            shares
        }
    }

    /// ERC-721-like `owner_of` for the anonymizer's burn detection. Reverts on burned
    /// (matches OpenZeppelin ERC-721 semantics — the SafeDispatcher catches this).
    #[abi(embed_v0)]
    impl MockNftImpl of IRedeemRequestNft<ContractState> {
        fn owner_of(self: @ContractState, token_id: u256) -> ContractAddress {
            let owner = self.nft_owner.read(token_id);
            assert(owner.is_non_zero(), 'ERC721: invalid token ID');
            owner
        }
    }
}

/// Mock ForgeYields gateway that returns zero shares on deposit. Used for
/// `ZERO_OUT_AMOUNT` tests.
#[starknet::contract]
pub mod MockForgeGatewayNoop {
    use core::num::traits::Zero;
    use forge_yields_anonymizer::forge_yields_anonymizer::{IForgeTokenGateway, IRedeemRequestNft};
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::storage::StoragePointerWriteAccess;
    use starknet::{ContractAddress, get_contract_address};

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
    impl MockForgeGatewayImpl of IForgeTokenGateway<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            Zero::zero()
        }
        fn request_redeem(
            ref self: ContractState,
            shares: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            Zero::zero()
        }
        fn claim_redeem(ref self: ContractState, id: u256) -> u256 {
            Zero::zero()
        }
        fn redeem_request(self: @ContractState) -> ContractAddress {
            get_contract_address()
        }
        fn due_assets_from_id(self: @ContractState, id: u256) -> u256 {
            Zero::zero()
        }
    }

    #[abi(embed_v0)]
    impl MockNftImpl of IRedeemRequestNft<ContractState> {
        fn owner_of(self: @ContractState, token_id: u256) -> ContractAddress {
            Zero::zero()
        }
    }
}

/// Mock ForgeYields gateway that mints shares exceeding `u128::MAX`. Used for
/// `RECEIVED_AMOUNT_OVERFLOW` tests on the deposit path.
#[starknet::contract]
pub mod MockForgeGatewayOverflow {
    use core::num::traits::Zero;
    use forge_yields_anonymizer::forge_yields_anonymizer::{IForgeTokenGateway, IRedeemRequestNft};
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::storage::StoragePointerWriteAccess;
    use starknet::{ContractAddress, get_contract_address};
    use starkware_utils::constants::MAX_U128;

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
    impl MockForgeGatewayImpl of IForgeTokenGateway<ContractState> {
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            let overflow_amount: u256 = MAX_U128.into() + 1;
            self.erc20.mint(recipient: receiver, amount: overflow_amount);
            overflow_amount
        }
        fn request_redeem(
            ref self: ContractState,
            shares: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            Zero::zero()
        }
        fn claim_redeem(ref self: ContractState, id: u256) -> u256 {
            Zero::zero()
        }
        fn redeem_request(self: @ContractState) -> ContractAddress {
            get_contract_address()
        }
        fn due_assets_from_id(self: @ContractState, id: u256) -> u256 {
            Zero::zero()
        }
    }

    #[abi(embed_v0)]
    impl MockNftImpl of IRedeemRequestNft<ContractState> {
        fn owner_of(self: @ContractState, token_id: u256) -> ContractAddress {
            Zero::zero()
        }
    }
}
