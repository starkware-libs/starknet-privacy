//! Devnet-friendly mock of the ForgeYields `TokenGateway` contract.
//!
//! Mirrors the real gateway's selectors (deposit + redeem) and event shapes so that
//! the SDK, the `ForgeYieldsAnonymizer`, and the demo UI can talk to it with identical
//! calldata and decode identical events. The cross-chain plumbing (Hyperlane,
//! Controller, L1 bridge) is replaced by a single admin shortcut: `process_epoch(new_pps)`
//! simulates the controller's epoch-settlement report — it bumps the epoch counter,
//! sets the current `pps`, and snapshots that pps for redemption fix-up.
//!
//! ## Redemption model
//!
//! Redemption is **asynchronous and epoch-gated**, matching the real protocol:
//!
//! 1. User calls `request_redeem(shares, receiver, owner)`:
//!    - burns `shares` from `owner` (caller must be `owner` for this mock)
//!    - records `{ owner, receiver, shares, request_epoch: current epoch }`
//!    - emits `RedeemRequested`, returns the request `id`.
//!
//! 2. Admin (or anyone, in this mock) calls `process_epoch(new_pps)`:
//!    - increments `epoch`
//!    - sets `pps = new_pps`
//!    - snapshots `pps_by_epoch[epoch] = new_pps` so the settlement price is fixed.
//!
//! 3. User calls `claim_redeem(id)`:
//!    - checks `current_epoch > request_epoch` (so at least one epoch has settled)
//!    - reads `pps_by_epoch[request_epoch + 1]` as the settlement price
//!    - computes `assets = shares * settle_pps / WAD`
//!    - transfers underlying to `receiver`, marks the request claimed
//!    - emits `RedeemClaimed`.
//!
//! The gateway is itself the share ERC-20 (matching real ForgeYields: `HypERC20 +
//! OpenZeppelin ERC-20`), so `out_token` for the anonymizer's `Deposit` op is this
//! contract's own address.

#[starknet::interface]
pub trait IMockForgeYieldsGateway<T> {
    // ── ERC-4626 deposit path (real gateway selectors)
    // ─────────────────────────────
    fn deposit(ref self: T, assets: u256, receiver: starknet::ContractAddress) -> u256;
    fn mint(ref self: T, shares: u256, receiver: starknet::ContractAddress) -> u256;

    // ── Redemption (real gateway selectors, epoch-gated implementation)
    // ────────────
    fn request_redeem(
        ref self: T,
        shares: u256,
        receiver: starknet::ContractAddress,
        owner: starknet::ContractAddress,
    ) -> u256;
    fn claim_redeem(ref self: T, id: u256) -> u256;

    // ── Views
    // ──────────────────────────────────────────────────────────────────────
    fn asset(self: @T) -> starknet::ContractAddress;
    fn pps(self: @T) -> u256;
    fn pps_at_epoch(self: @T, epoch: u256) -> u256;
    fn epoch(self: @T) -> u256;
    fn is_stale(self: @T) -> bool;
    fn paused(self: @T) -> bool;
    fn convert_to_assets(self: @T, shares: u256) -> u256;
    fn convert_to_shares(self: @T, assets: u256) -> u256;
    fn preview_deposit(self: @T, assets: u256) -> u256;
    fn preview_mint(self: @T, shares: u256) -> u256;
    fn max_deposit(self: @T, receiver: starknet::ContractAddress) -> u256;
    fn max_mint(self: @T, receiver: starknet::ContractAddress) -> u256;
    fn buffer(self: @T) -> u256;
    fn redeem_request_of(self: @T, id: u256) -> RedeemRequestView;

    // ── Real-gateway-compatible views used by the anonymizer's redemption flow ─
    /// Returns the address of the NFT contract (= self in this mock).
    fn redeem_request(self: @T) -> starknet::ContractAddress;
    /// Returns the settled assets due for an id. Works before AND after the NFT is
    /// burned because the redemption record (shares/epoch/owner) persists post-claim
    /// in this mock (`claimed` flag flips but `shares`/`request_epoch` stay).
    fn due_assets_from_id(self: @T, id: u256) -> u256;
    /// ERC-721-like `owner_of`. Reverts on burned (= claimed) ids so the
    /// anonymizer's SafeDispatcher can detect "already settled".
    fn owner_of(self: @T, token_id: u256) -> starknet::ContractAddress;

    // ── Mock-only admin (replaces Hyperlane controller report)
    // ─────────────────────
    fn process_epoch(ref self: T, new_pps: u256);
    fn set_paused(ref self: T, paused: bool);
    fn set_stale(ref self: T, stale: bool);
}

/// Public view of a stored redemption request.
#[derive(Drop, Copy, Serde, starknet::Store)]
pub struct RedeemRequestView {
    pub owner: starknet::ContractAddress,
    pub receiver: starknet::ContractAddress,
    pub shares: u256,
    pub request_epoch: u256,
    pub claimed: bool,
}

pub mod errors {
    pub const PAUSED: felt252 = 'GATEWAY_PAUSED';
    pub const STALE: felt252 = 'GATEWAY_STALE';
    pub const ZERO_ASSETS: felt252 = 'ZERO_ASSETS';
    pub const ZERO_SHARES: felt252 = 'ZERO_SHARES';
    pub const UNAUTHORIZED_REDEEMER: felt252 = 'UNAUTHORIZED_REDEEMER';
    pub const UNAUTHORIZED_CLAIMER: felt252 = 'UNAUTHORIZED_CLAIMER';
    pub const NOT_CLAIMABLE_YET: felt252 = 'NOT_CLAIMABLE_YET';
    pub const ALREADY_CLAIMED: felt252 = 'ALREADY_CLAIMED';
    pub const UNKNOWN_REQUEST: felt252 = 'UNKNOWN_REQUEST';
}

#[starknet::contract]
pub mod MockForgeYieldsGateway {
    use core::num::traits::{Bounded, Zero};
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IMockForgeYieldsGateway, RedeemRequestView, errors};

    /// 1e18 — matches `Constants::WAD` in the real gateway. Shares are always 18 dec.
    const WAD: u256 = 1_000_000_000_000_000_000;

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
        underlying: ContractAddress,
        pps: u256,
        epoch: u256,
        is_paused: bool,
        is_stale: bool,
        /// Total underlying held by the strategy (mock keeps it all on this contract).
        buffer: u256,
        /// Auto-incrementing redemption request id. First id assigned is 1; id 0 is reserved.
        next_id: u256,
        /// id → request record. Storing the full struct mirrors the real gateway's NFT-id layout.
        redeem_requests: Map<u256, RedeemRequestView>,
        /// epoch → snapshotted pps. Set by `process_epoch`. A redemption requested at epoch E
        /// settles at `pps_by_epoch[E + 1]`, so later epoch reports never re-price old requests.
        pps_by_epoch: Map<u256, u256>,
    }

    /// Events mirror the real gateway's selector shapes so devnet listeners decode them.
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
        Deposit: Deposit,
        RedeemRequested: RedeemRequested,
        RedeemClaimed: RedeemClaimed,
        EpochProcessed: EpochProcessed,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Deposit {
        #[key]
        pub sender: ContractAddress,
        #[key]
        pub owner: ContractAddress,
        pub assets: u256,
        pub shares: u256,
        pub referral_code: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RedeemRequested {
        pub owner: ContractAddress,
        pub receiver: ContractAddress,
        pub shares: u256,
        pub id: u256,
        pub epoch: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RedeemClaimed {
        pub receiver: ContractAddress,
        pub shares: u256,
        pub assets: u256,
        pub id: u256,
        pub epoch: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct EpochProcessed {
        pub epoch: u256,
        pub new_pps: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: ByteArray,
        symbol: ByteArray,
        underlying: ContractAddress,
        initial_pps: u256,
    ) {
        self.erc20.initializer(name, symbol);
        self.underlying.write(underlying);
        let starting_pps = if initial_pps == 0 {
            WAD
        } else {
            initial_pps
        };
        self.pps.write(starting_pps);
        self.epoch.write(0);
        // Epoch 0's snapshot is the starting pps so a request at epoch 0 can settle at
        // epoch 1's reported pps; the value is overwritten on next `process_epoch`.
        self.pps_by_epoch.write(0, starting_pps);
        self.is_paused.write(false);
        self.is_stale.write(false);
        self.buffer.write(0);
        self.next_id.write(1);
    }

    #[abi(embed_v0)]
    impl MockForgeYieldsGatewayImpl of IMockForgeYieldsGateway<ContractState> {
        // ── Deposit path
        // ───────────────────────────────────────────────────────────
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            self._assert_open();
            assert(assets != 0, errors::ZERO_ASSETS);

            let shares = self._convert_to_shares(assets);
            assert(shares != 0, errors::ZERO_SHARES);

            IERC20Dispatcher { contract_address: self.underlying.read() }
                .transfer_from(
                    sender: get_caller_address(), recipient: get_contract_address(), amount: assets,
                );
            self.buffer.write(self.buffer.read() + assets);
            self.erc20.mint(recipient: receiver, amount: shares);

            self
                .emit(
                    Deposit {
                        sender: get_caller_address(),
                        owner: receiver,
                        assets,
                        shares,
                        referral_code: 0,
                    },
                );
            shares
        }

        fn mint(ref self: ContractState, shares: u256, receiver: ContractAddress) -> u256 {
            self._assert_open();
            assert(shares != 0, errors::ZERO_SHARES);
            let assets = self._convert_to_assets(shares);
            assert(assets != 0, errors::ZERO_ASSETS);

            IERC20Dispatcher { contract_address: self.underlying.read() }
                .transfer_from(
                    sender: get_caller_address(), recipient: get_contract_address(), amount: assets,
                );
            self.buffer.write(self.buffer.read() + assets);
            self.erc20.mint(recipient: receiver, amount: shares);

            self
                .emit(
                    Deposit {
                        sender: get_caller_address(),
                        owner: receiver,
                        assets,
                        shares,
                        referral_code: 0,
                    },
                );
            assets
        }

        // ── Redemption
        // ─────────────────────────────────────────────────────────────
        fn request_redeem(
            ref self: ContractState,
            shares: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            self._assert_open();
            assert(shares != 0, errors::ZERO_SHARES);
            // For this mock the caller must be the owner (no allowance flow).
            assert(get_caller_address() == owner, errors::UNAUTHORIZED_REDEEMER);

            // Burn the shares immediately — value is locked at the settlement pps.
            self.erc20.burn(account: owner, amount: shares);

            let id = self.next_id.read();
            self.next_id.write(id + 1);
            let request_epoch = self.epoch.read();
            self
                .redeem_requests
                .write(
                    id,
                    RedeemRequestView { owner, receiver, shares, request_epoch, claimed: false },
                );
            self.emit(RedeemRequested { owner, receiver, shares, id, epoch: request_epoch });
            id
        }

        fn claim_redeem(ref self: ContractState, id: u256) -> u256 {
            let req = self.redeem_requests.read(id);
            assert(req.owner.is_non_zero(), errors::UNKNOWN_REQUEST);
            assert(!req.claimed, errors::ALREADY_CLAIMED);

            // Settlement epoch is the one right after the request was filed.
            let settle_epoch = req.request_epoch + 1;
            assert(self.epoch.read() >= settle_epoch, errors::NOT_CLAIMABLE_YET);

            // Permissionless — anyone can call. Funds always go to `req.receiver`
            // (the NFT owner). Mirrors the real gateway's permissionless behavior.

            let settle_pps = self.pps_by_epoch.read(settle_epoch);
            let assets = (req.shares * settle_pps) / WAD;

            // Mark claimed before external transfer (CEI ordering).
            self
                .redeem_requests
                .write(
                    id,
                    RedeemRequestView {
                        owner: req.owner,
                        receiver: req.receiver,
                        shares: req.shares,
                        request_epoch: req.request_epoch,
                        claimed: true,
                    },
                );
            // Use the real on-chain balance for the solvency check so the test
            // can simulate yield by minting extra underlying directly to the
            // gateway address (matches the real protocol where yield accrues
            // on-balance, not via the deposit path).
            let underlying = IERC20Dispatcher { contract_address: self.underlying.read() };
            let real_balance = underlying.balance_of(account: get_contract_address());
            assert(real_balance >= assets, errors::ZERO_ASSETS);

            // Keep `buffer` accounting in sync for views, capped at what we just
            // had — don't underflow if buffer accounting fell behind real balance.
            let buffer_before = self.buffer.read();
            if buffer_before >= assets {
                self.buffer.write(buffer_before - assets);
            } else {
                self.buffer.write(0);
            }

            underlying.transfer(recipient: req.receiver, amount: assets);

            self
                .emit(
                    RedeemClaimed {
                        receiver: req.receiver,
                        shares: req.shares,
                        assets,
                        id,
                        epoch: req.request_epoch,
                    },
                );
            assets
        }

        // ── Views
        // ──────────────────────────────────────────────────────────────────
        fn asset(self: @ContractState) -> ContractAddress {
            self.underlying.read()
        }
        fn pps(self: @ContractState) -> u256 {
            self.pps.read()
        }
        fn pps_at_epoch(self: @ContractState, epoch: u256) -> u256 {
            self.pps_by_epoch.read(epoch)
        }
        fn epoch(self: @ContractState) -> u256 {
            self.epoch.read()
        }
        fn is_stale(self: @ContractState) -> bool {
            self.is_stale.read()
        }
        fn paused(self: @ContractState) -> bool {
            self.is_paused.read()
        }
        fn buffer(self: @ContractState) -> u256 {
            self.buffer.read()
        }
        fn convert_to_assets(self: @ContractState, shares: u256) -> u256 {
            self._convert_to_assets(shares)
        }
        fn convert_to_shares(self: @ContractState, assets: u256) -> u256 {
            self._convert_to_shares(assets)
        }
        fn preview_deposit(self: @ContractState, assets: u256) -> u256 {
            self._convert_to_shares(assets)
        }
        fn preview_mint(self: @ContractState, shares: u256) -> u256 {
            self._convert_to_assets(shares)
        }
        fn max_deposit(self: @ContractState, receiver: ContractAddress) -> u256 {
            if self.is_paused.read() || self.is_stale.read() {
                0
            } else {
                Bounded::<u256>::MAX
            }
        }
        fn max_mint(self: @ContractState, receiver: ContractAddress) -> u256 {
            if self.is_paused.read() || self.is_stale.read() {
                0
            } else {
                Bounded::<u256>::MAX
            }
        }
        fn redeem_request_of(self: @ContractState, id: u256) -> RedeemRequestView {
            self.redeem_requests.read(id)
        }

        // ── Real-gateway-compatible views (used by the anonymizer)
        // ─────────────
        fn redeem_request(self: @ContractState) -> ContractAddress {
            // The NFT contract address. In this mock the gateway plays both roles.
            get_contract_address()
        }

        fn due_assets_from_id(self: @ContractState, id: u256) -> u256 {
            let req = self.redeem_requests.read(id);
            assert(req.owner.is_non_zero(), errors::UNKNOWN_REQUEST);
            // Use the settlement epoch's pps snapshot if it has been processed.
            // Before settle: nominal value (shares — pre-pps). After settle: shares * pps.
            let settle_epoch = req.request_epoch + 1;
            if self.epoch.read() >= settle_epoch {
                let settle_pps = self.pps_by_epoch.read(settle_epoch);
                (req.shares * settle_pps) / WAD
            } else {
                req.shares
            }
        }

        fn owner_of(self: @ContractState, token_id: u256) -> ContractAddress {
            // ERC-721 semantics: revert on non-existent / burned token.
            let req = self.redeem_requests.read(token_id);
            assert(req.owner.is_non_zero(), 'ERC721: invalid token ID');
            // `claimed` = true ↔ NFT burned in this mock.
            assert(!req.claimed, 'ERC721: invalid token ID');
            req.receiver
        }

        // ── Admin shortcuts (replace Hyperlane / Controller)
        // ───────────────────────
        fn process_epoch(ref self: ContractState, new_pps: u256) {
            let next = self.epoch.read() + 1;
            self.epoch.write(next);
            self.pps.write(new_pps);
            // Snapshot for redemption fix-up: requests filed at epoch N settle at
            // pps_by_epoch[N+1]. Writing pps_by_epoch[next] supplies that value.
            self.pps_by_epoch.write(next, new_pps);
            self.is_stale.write(false);
            self.emit(EpochProcessed { epoch: next, new_pps });
        }

        fn set_paused(ref self: ContractState, paused: bool) {
            self.is_paused.write(paused);
        }

        fn set_stale(ref self: ContractState, stale: bool) {
            self.is_stale.write(stale);
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        fn _assert_open(self: @ContractState) {
            assert(!self.is_paused.read(), errors::PAUSED);
            assert(!self.is_stale.read(), errors::STALE);
        }

        fn _convert_to_shares(self: @ContractState, assets: u256) -> u256 {
            (assets * WAD) / self.pps.read()
        }

        fn _convert_to_assets(self: @ContractState, shares: u256) -> u256 {
            (shares * self.pps.read()) / WAD
        }
    }
}
