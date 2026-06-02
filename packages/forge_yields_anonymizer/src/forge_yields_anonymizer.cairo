//! ForgeYields anonymizer — private deposit + epoch-gated redemption on ForgeYields strategies.
//!
//! ForgeYields' `TokenGateway` is ERC-4626-compatible (the gateway IS the share ERC-20).
//! Redemption is async + NFT-id-based, settled by ForgeYields' off-chain controller
//! reporting back next epoch. The actual `gateway.claim_redeem(id)` is permissionless and
//! pays out to `owner_of(id)` (the NFT holder, which is this anonymizer).
//!
//! ## Architecture: anonymizer is a query-based router, never a gateway claimer
//!
//! Crucially, **this anonymizer NEVER calls `gateway.claim_redeem`**. The actual claim is
//! triggered by ForgeYields' automated service (or anyone — claim is permissionless,
//! funds always go to the NFT owner = anonymizer). The anonymizer's job at claim time
//! is purely:
//!
//!  1. verify the wallet's secret matches the stored commitment
//!  2. verify the NFT has indeed been burned (so the funds are on us)
//!  3. ask the gateway "how much was due for this id?" via `due_assets_from_id`
//!  4. route that amount from the anonymizer to a fresh open note in the privacy pool
//!
//! Why this matters: there's no DoS via gateway front-running. If a bot or the auto
//! service calls `gateway.claim_redeem(id)` before Alice's claim tx, the funds land on
//! the anonymizer (correct destination) and Alice's claim still works — the anonymizer
//! just doesn't need to call claim itself. The gateway is the authoritative oracle for
//! "how much is attributed to this id" (`id_to_info(id)` persists through burn, and
//! `redeem_assets/redeem_shares` ratios are preserved across individual claims).
//!
//! ## Operations
//!
//! 1. `Deposit { gateway, underlying, assets, note_id }` — same as before: anonymizer
//!    holds underlying, calls `gateway.deposit`, fills an open note with the resulting shares.
//!
//! 2. `RequestRedeem { gateway, shares, commitment }` — anonymizer holds shares, calls
//!    `gateway.request_redeem(shares, self, self)` → gets `id`. Stores `(gateway, id) →
//!    commitment`. Returns empty span. Emits `RedemptionRequested { gateway, id, commitment }`.
//!
//! 3. `ClaimRedeem { gateway, redemption_id, secret, underlying, note_id }` —
//!    verifies `poseidon([secret]) == stored commitment`, asserts the NFT for `id` has
//!    been burned (= the gateway claim happened), reads `due_assets_from_id(id)`, and
//!    routes that exact amount to the open note. Clears the commitment to prevent
//!    replays.

use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

/// Subset of the ForgeYields `TokenGateway` interface used by this anonymizer.
///
/// `claim_redeem` is callable opportunistically when the redemption NFT still exists
/// (in the same atomic tx as the user's privacy claim). When the NFT has already been
/// burned by an external party (the ForgeYields auto-service, a bot, anyone — claim is
/// permissionless and funds always go to the NFT owner = anonymizer), the anonymizer
/// skips its own call. In both cases `due_assets_from_id` is the authoritative source
/// for the amount owed.
#[starknet::interface]
pub trait IForgeTokenGateway<T> {
    /// Pulls `assets` underlying from caller, mints shares to `receiver`.
    fn deposit(ref self: T, assets: u256, receiver: ContractAddress) -> u256;
    /// Burns `shares` from `owner`, mints redemption NFT to `receiver`. Returns the NFT id.
    fn request_redeem(
        ref self: T, shares: u256, receiver: ContractAddress, owner: ContractAddress,
    ) -> u256;
    /// Burns the NFT and transfers underlying to `owner_of(id)`. Permissionless — anyone
    /// can call. Reverts on unknown/already-burned id (so we guard with `owner_of` first).
    fn claim_redeem(ref self: T, id: u256) -> u256;
    /// Returns the address of the ERC-721 contract that issues redemption NFTs.
    fn redeem_request(self: @T) -> ContractAddress;
    /// Returns the assets currently due for a given redemption id. Works **before AND after**
    /// the NFT is burned because `id_to_info(id)` persists and the per-epoch ratios are
    /// preserved across individual claims.
    fn due_assets_from_id(self: @T, id: u256) -> u256;
}

/// Minimal ERC-721 surface the anonymizer needs to check whether the redemption NFT has
/// been burned. We use the **safe** dispatcher: `owner_of(id)` reverts on burned tokens,
/// and we catch that revert via `Result::Err` to detect the burn.
#[starknet::interface]
pub trait IRedeemRequestNft<T> {
    fn owner_of(self: @T, token_id: u256) -> ContractAddress;
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct DepositParams {
    pub gateway: ContractAddress,
    pub underlying: ContractAddress,
    pub assets: u256,
    pub note_id: felt252,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct RequestRedeemParams {
    pub gateway: ContractAddress,
    pub shares: u256,
    /// Hash committing to the secret needed at claim time. Use `poseidon_hash_span([secret])`.
    pub commitment: felt252,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct ClaimRedeemParams {
    pub gateway: ContractAddress,
    pub redemption_id: u256,
    /// Pre-image of the commitment supplied at request time.
    pub secret: felt252,
    /// Underlying asset address that will fill the open note.
    pub underlying: ContractAddress,
    pub note_id: felt252,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum ForgeOperation {
    Deposit: DepositParams,
    RequestRedeem: RequestRedeemParams,
    ClaimRedeem: ClaimRedeemParams,
}

#[starknet::interface]
pub trait IForgeYieldsAnonymizer<T> {
    fn privacy_invoke(ref self: T, operation: ForgeOperation) -> Span<OpenNoteDeposit>;
}

pub mod errors {
    pub const ZERO_GATEWAY: felt252 = 'ZERO_GATEWAY';
    pub const ZERO_UNDERLYING: felt252 = 'ZERO_UNDERLYING';
    pub const ZERO_ASSETS: felt252 = 'ZERO_ASSETS';
    pub const ZERO_SHARES: felt252 = 'ZERO_SHARES';
    pub const TOKENS_EQUAL: felt252 = 'TOKENS_EQUAL';
    pub const RECEIVED_AMOUNT_OVERFLOW: felt252 = 'RECEIVED_AMOUNT_OVERFLOW';
    pub const ZERO_OUT_AMOUNT: felt252 = 'ZERO_OUT_AMOUNT';
    pub const ZERO_COMMITMENT: felt252 = 'ZERO_COMMITMENT';
    pub const ALREADY_COMMITTED: felt252 = 'ALREADY_COMMITTED';
    pub const UNKNOWN_REDEMPTION: felt252 = 'UNKNOWN_REDEMPTION';
    pub const BAD_SECRET: felt252 = 'BAD_SECRET';
    pub const ZERO_DUE_ASSETS: felt252 = 'ZERO_DUE_ASSETS';
}

#[starknet::contract]
pub mod ForgeYieldsAnonymizer {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{
        ClaimRedeemParams, DepositParams, ForgeOperation, IForgeTokenGatewayDispatcher,
        IForgeTokenGatewayDispatcherTrait, IForgeYieldsAnonymizer, IRedeemRequestNftSafeDispatcher,
        IRedeemRequestNftSafeDispatcherTrait, RequestRedeemParams, errors,
    };

    #[storage]
    struct Storage {
        /// (gateway, redemption_id) -> commitment. Cleared on successful claim.
        redemption_commitments: Map<(ContractAddress, u256), felt252>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        RedemptionRequested: RedemptionRequested,
        RedemptionClaimed: RedemptionClaimed,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RedemptionRequested {
        #[key]
        pub gateway: ContractAddress,
        pub redemption_id: u256,
        pub commitment: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RedemptionClaimed {
        #[key]
        pub gateway: ContractAddress,
        pub redemption_id: u256,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl ForgeYieldsAnonymizerImpl of IForgeYieldsAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, operation: ForgeOperation,
        ) -> Span<OpenNoteDeposit> {
            match operation {
                ForgeOperation::Deposit(p) => self._deposit(p),
                ForgeOperation::RequestRedeem(p) => self._request_redeem(p),
                ForgeOperation::ClaimRedeem(p) => self._claim_redeem(p),
            }
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        fn _deposit(ref self: ContractState, p: DepositParams) -> Span<OpenNoteDeposit> {
            assert(p.underlying.is_non_zero(), errors::ZERO_UNDERLYING);
            assert(p.gateway.is_non_zero(), errors::ZERO_GATEWAY);
            assert(p.assets.is_non_zero(), errors::ZERO_ASSETS);
            assert(p.underlying != p.gateway, errors::TOKENS_EQUAL);

            let self_addr = get_contract_address();
            let privacy_addr = get_caller_address();
            let underlying = IERC20Dispatcher { contract_address: p.underlying };
            let gateway_erc20 = IERC20Dispatcher { contract_address: p.gateway };

            let balance_before = gateway_erc20.balance_of(account: self_addr);

            underlying.approve(spender: p.gateway, amount: p.assets);
            IForgeTokenGatewayDispatcher { contract_address: p.gateway }
                .deposit(assets: p.assets, receiver: self_addr);

            let balance_after = gateway_erc20.balance_of(account: self_addr);
            let out_amount: u128 = (balance_after - balance_before)
                .try_into()
                .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
            assert(out_amount.is_non_zero(), errors::ZERO_OUT_AMOUNT);

            gateway_erc20.approve(spender: privacy_addr, amount: out_amount.into());
            [OpenNoteDeposit { note_id: p.note_id, token: p.gateway, amount: out_amount }].span()
        }

        fn _request_redeem(
            ref self: ContractState, p: RequestRedeemParams,
        ) -> Span<OpenNoteDeposit> {
            assert(p.gateway.is_non_zero(), errors::ZERO_GATEWAY);
            assert(p.shares.is_non_zero(), errors::ZERO_SHARES);
            assert(p.commitment != 0, errors::ZERO_COMMITMENT);

            let self_addr = get_contract_address();

            // Gateway burns `shares` from us (we hold them) and mints the redemption
            // NFT with receiver=self, owner=self. Returns the new id.
            let id = IForgeTokenGatewayDispatcher { contract_address: p.gateway }
                .request_redeem(shares: p.shares, receiver: self_addr, owner: self_addr);

            let key = (p.gateway, id);
            assert(self.redemption_commitments.read(key) == 0, errors::ALREADY_COMMITTED);
            self.redemption_commitments.write(key, p.commitment);

            self
                .emit(
                    RedemptionRequested {
                        gateway: p.gateway, redemption_id: id, commitment: p.commitment,
                    },
                );

            [].span()
        }

        fn _claim_redeem(ref self: ContractState, p: ClaimRedeemParams) -> Span<OpenNoteDeposit> {
            assert(p.gateway.is_non_zero(), errors::ZERO_GATEWAY);
            assert(p.underlying.is_non_zero(), errors::ZERO_UNDERLYING);
            assert(p.underlying != p.gateway, errors::TOKENS_EQUAL);

            // 1. Verify commitment.
            let key = (p.gateway, p.redemption_id);
            let commitment = self.redemption_commitments.read(key);
            assert(commitment != 0, errors::UNKNOWN_REDEMPTION);
            let expected = poseidon_hash_span([p.secret].span());
            assert(expected == commitment, errors::BAD_SECRET);

            // 2. Opportunistic claim. The gateway's `claim_redeem` is permissionless and
            //    pays out to `owner_of(id)` (= this anonymizer). Two cases:
            //      (a) NFT still alive — auto-service hasn't fired yet. We trigger the
            //          claim ourselves inside this atomic tx (no front-run possible).
            //      (b) NFT already burned — auto-service / bot / anyone has fired the
            //          claim. Funds already on us. Skip the call.
            //    `due_assets_from_id` is the authoritative source in both cases
            //    (id_to_info persists post-burn, per-epoch ratios are preserved).
            let gateway_disp = IForgeTokenGatewayDispatcher { contract_address: p.gateway };
            let nft_addr = gateway_disp.redeem_request();
            let nft_safe = IRedeemRequestNftSafeDispatcher { contract_address: nft_addr };
            let nft_still_exists = match nft_safe.owner_of(p.redemption_id) {
                Result::Ok(_) => true,
                Result::Err(_) => false,
            };
            if nft_still_exists {
                gateway_disp.claim_redeem(id: p.redemption_id);
            }

            // 3. Read the authoritative amount due.
            let due = gateway_disp.due_assets_from_id(p.redemption_id);
            assert(due.is_non_zero(), errors::ZERO_DUE_ASSETS);

            // 4. Clear the commitment (anti-replay, CEI before approve).
            self.redemption_commitments.write(key, 0);

            // 5. Approve the privacy pool to pull `due` from our balance.
            let out_amount: u128 = due.try_into().expect(errors::RECEIVED_AMOUNT_OVERFLOW);
            assert(out_amount.is_non_zero(), errors::ZERO_OUT_AMOUNT);

            let underlying_erc20 = IERC20Dispatcher { contract_address: p.underlying };
            underlying_erc20.approve(spender: get_caller_address(), amount: out_amount.into());

            self.emit(RedemptionClaimed { gateway: p.gateway, redemption_id: p.redemption_id });

            [OpenNoteDeposit { note_id: p.note_id, token: p.underlying, amount: out_amount }].span()
        }
    }
}
