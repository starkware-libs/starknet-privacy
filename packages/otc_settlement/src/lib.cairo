use privacy::actions::ServerAction;
use privacy::events::EncNoteCreated;
use privacy::objects::OpenNoteDeposit;

#[starknet::interface]
pub trait IOtcSettlement<T> {
    fn join_trade(ref self: T, trade_id: felt252, actions: Span<ServerAction>);
}

#[starknet::interface]
pub trait IPrivacyInvoke<T> {
    // Called by the privacy pool during apply_stored_actions via INVOKE_SELECTOR =
    // selector!("privacy_invoke"). Verifies that the counterparty committed to a
    // transfer matching `expected` — pinning the trade to the agreed token+amount.
    fn privacy_invoke(
        ref self: T, trade_id: felt252, expected: EncNoteCreated,
    ) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod OtcSettlement {
    use privacy::actions::ServerAction;
    use privacy::events::EncNoteCreated;
    use privacy::interface::{
        IServerDispatcher, IServerDispatcherTrait, IViewsDispatcher, IViewsDispatcherTrait,
    };
    use privacy::objects::OpenNoteDeposit;
    use starknet::ContractAddress;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };

    #[derive(Drop, Copy, Default, starknet::Store)]
    struct TradeHashes {
        first_hash: felt252,
        second_hash: felt252,
    }

    #[storage]
    struct Storage {
        privacy_contract: ContractAddress,
        trade_hashes: Map<felt252, TradeHashes>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, privacy_contract: ContractAddress) {
        self.privacy_contract.write(privacy_contract);
    }

    #[abi(embed_v0)]
    impl PrivacyInvokeImpl of super::IPrivacyInvoke<ContractState> {
        // Strategy:
        // - The pool's `apply_stored_actions` drains the stored Vec BEFORE running
        //   `_apply_actions`, so the calling party's own action list is empty here.
        // - InvokeExternal runs in the final action phase, so by the time this
        //   fires, all of the calling party's notes have already been written to
        //   the pool's `notes` storage.
        // - join_trade applies the SECOND party first, then FIRST. So:
        //     * Second's privacy_invoke: first's vec is still intact → search it.
        //     * First's privacy_invoke: both vecs drained → second's notes are now
        //       in pool storage → verify via `get_note(expected.note_id)`.
        // - Note IDs include channel_key + token, so a packed_value match for the
        //   given note_id is a token+amount-bound proof that the counterparty
        //   committed the agreed transfer.
        fn privacy_invoke(
            ref self: ContractState, trade_id: felt252, expected: EncNoteCreated,
        ) -> Span<OpenNoteDeposit> {
            let hashes = self.trade_hashes.entry(trade_id);
            let pool_addr = self.privacy_contract.read();
            let views = IViewsDispatcher { contract_address: pool_addr };
            let expected_action = ServerAction::EmitEncNoteCreated(expected);

            let mut first_raw = views.get_stored_actions(hashes.first_hash.read());
            if first_raw.len() != 0 {
                let first_actions = core::serde::Serde::<
                    Span<ServerAction>,
                >::deserialize(ref first_raw)
                    .expect('INVALID_FIRST_ACTIONS');
                if contains_action(expected_action, first_actions) {
                    return array![].span();
                }
            }

            let mut second_raw = views.get_stored_actions(hashes.second_hash.read());
            if second_raw.len() != 0 {
                let second_actions = core::serde::Serde::<
                    Span<ServerAction>,
                >::deserialize(ref second_raw)
                    .expect('INVALID_SECOND_ACTIONS');
                if contains_action(expected_action, second_actions) {
                    return array![].span();
                }
            }

            // Both Vecs drained — actions have been applied. The expected note now
            // lives in the pool's `notes` storage. Compare packed_value directly.
            let note = views.get_note(expected.note_id);
            assert(note.packed_value == expected.packed_value, 'EXPECTED_NOTE_NOT_FOUND');
            array![].span()
        }
    }

    #[abi(embed_v0)]
    impl OtcSettlementImpl of super::IOtcSettlement<ContractState> {
        fn join_trade(ref self: ContractState, trade_id: felt252, actions: Span<ServerAction>) {
            let privacy = IServerDispatcher {
                contract_address: self.privacy_contract.read(),
            };
            let hash = privacy.store_actions(actions);
            let hashes = self.trade_hashes.entry(trade_id);
            let first = hashes.first_hash.read();
            if first == 0 {
                hashes.first_hash.write(hash);
            } else {
                hashes.second_hash.write(hash);
                privacy.apply_stored_actions(hash);
                privacy.apply_stored_actions(first);
                hashes.first_hash.write(0);
                hashes.second_hash.write(0);
            }
        }
    }

    fn contains_action(action: ServerAction, actions: Span<ServerAction>) -> bool {
        for a in actions {
            if *a == action {
                return true;
            }
        };
        false
    }
}
