//! Mocks standing in for an open-note depositor whose
//! [`OpenNoteScreeningPolicy`](privacy::objects::OpenNoteScreeningPolicy) is `Delegated`.
//!
//! A delegated depositor returns the addresses its deposits are associated with after those
//! deposits, in the same return data, so these mocks differ from an ordinary depositor only in
//! what their compute-invoke returns.
//!
//! [`MockDelegatedTarget`] implements both `privacy_invoke` and
//! `privacy_invoke_with_computation`, standing in for a target that offers both: only the latter
//! appends addresses, since only the latter is delegated.

use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockDelegatedTarget<T> {
    /// Binds an identity key to a commitment, mirroring the two-stage flow the pool's compute
    /// path drives: its result is prepended to the invoke's calldata.
    fn privacy_compute(self: @T, identity_key: felt252) -> felt252;
    /// Returns the given deposits as-is, funding the pool's open notes, followed by the addresses
    /// this mock was deployed with.
    fn privacy_invoke_with_computation(
        ref self: T, commitment: felt252, deposits: Span<OpenNoteDeposit>,
    ) -> (Span<OpenNoteDeposit>, Span<ContractAddress>);
    /// Funds open notes without a computation — never delegated, so these deposits are exempt and
    /// no addresses follow them.
    fn privacy_invoke(ref self: T, deposits: Span<OpenNoteDeposit>) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod MockDelegatedTarget {
    use privacy::objects::OpenNoteDeposit;
    use starknet::ContractAddress;
    use starknet::storage::{MutableVecTrait, StoragePointerReadAccess, Vec};
    use super::IMockDelegatedTarget;

    #[storage]
    struct Storage {
        associated_addresses: Vec<ContractAddress>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, associated_addresses: Span<ContractAddress>) {
        for associated_address in associated_addresses {
            self.associated_addresses.push(*associated_address);
        }
    }

    #[abi(embed_v0)]
    pub impl MockDelegatedTargetImpl of IMockDelegatedTarget<ContractState> {
        fn privacy_compute(self: @ContractState, identity_key: felt252) -> felt252 {
            identity_key
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState, commitment: felt252, deposits: Span<OpenNoteDeposit>,
        ) -> (Span<OpenNoteDeposit>, Span<ContractAddress>) {
            let mut associated_addresses: Array<ContractAddress> = array![];
            for index in 0..self.associated_addresses.len() {
                associated_addresses.append(self.associated_addresses.at(index).read());
            }
            (deposits, associated_addresses.span())
        }

        fn privacy_invoke(
            ref self: ContractState, deposits: Span<OpenNoteDeposit>,
        ) -> Span<OpenNoteDeposit> {
            deposits
        }
    }
}

/// A depositor listed `Delegated` that returns only its deposits — the misconfiguration the
/// policy invites, since nothing stops a governor from listing a depositor that names nobody.
#[starknet::interface]
pub trait IMockDelegatedWithoutAddresses<T> {
    fn privacy_compute(self: @T, identity_key: felt252) -> felt252;
    fn privacy_invoke_with_computation(
        ref self: T, commitment: felt252, deposits: Span<OpenNoteDeposit>,
    ) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod MockDelegatedWithoutAddresses {
    use privacy::objects::OpenNoteDeposit;
    use super::IMockDelegatedWithoutAddresses;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockDelegatedWithoutAddressesImpl of IMockDelegatedWithoutAddresses<ContractState> {
        fn privacy_compute(self: @ContractState, identity_key: felt252) -> felt252 {
            identity_key
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState, commitment: felt252, deposits: Span<OpenNoteDeposit>,
        ) -> Span<OpenNoteDeposit> {
            deposits
        }
    }
}

/// A delegated depositor whose deposits are followed by three bare felts rather than a well-formed
/// `Span<ContractAddress>`. The pool reads the first as the number of addresses that follow, so a
/// triple chosen to disagree with itself reaches each of the pool's rejections in turn:
/// `(5, _, _)` promises five addresses and delivers two, `(0, _, _)` promises none, and
/// `(1, addr, extra)` is a well-formed span with a felt left over after it.
#[starknet::interface]
pub trait IMockDelegatedMalformedAddresses<T> {
    fn privacy_compute(self: @T, identity_key: felt252) -> felt252;
    fn privacy_invoke_with_computation(
        ref self: T, commitment: felt252, deposits: Span<OpenNoteDeposit>,
    ) -> (Span<OpenNoteDeposit>, felt252, felt252, felt252);
}

#[starknet::contract]
pub mod MockDelegatedMalformedAddresses {
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::IMockDelegatedMalformedAddresses;

    #[storage]
    struct Storage {
        addresses_length: felt252,
        first_felt: felt252,
        second_felt: felt252,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        addresses_length: felt252,
        first_felt: felt252,
        second_felt: felt252,
    ) {
        self.addresses_length.write(addresses_length);
        self.first_felt.write(first_felt);
        self.second_felt.write(second_felt);
    }

    #[abi(embed_v0)]
    pub impl MockDelegatedMalformedAddressesImpl of IMockDelegatedMalformedAddresses<
        ContractState,
    > {
        fn privacy_compute(self: @ContractState, identity_key: felt252) -> felt252 {
            identity_key
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState, commitment: felt252, deposits: Span<OpenNoteDeposit>,
        ) -> (Span<OpenNoteDeposit>, felt252, felt252, felt252) {
            (
                deposits,
                self.addresses_length.read(),
                self.first_felt.read(),
                self.second_felt.read(),
            )
        }
    }
}
