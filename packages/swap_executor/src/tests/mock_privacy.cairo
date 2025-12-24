use privacy::interface::{IServer, IViews};
use privacy::objects::EncNote;

/// Mock Privacy contract for testing swap_executor functionality.
/// This contract simulates a basic privacy pool that stores notes and handles deposits.
#[starknet::contract]
pub mod MockPrivacy {
    use openzeppelin::token::erc20::interface::IERC20Dispatcher;
    use starknet::ContractAddress;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starkware_utils::erc20::erc20_utils::CheckedIERC20DispatcherTrait;
    use super::{EncNote, IServer, IViews};

    #[storage]
    struct Storage {
        /// Maps note_id to encrypted amount
        notes: Map<felt252, felt252>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        NoteCreated: NoteCreated,
        DepositExecuted: DepositExecuted,
    }

    #[derive(Drop, starknet::Event)]
    pub struct NoteCreated {
        pub note_id: felt252,
        pub enc_amount: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DepositExecuted {
        pub user_addr: ContractAddress,
        pub token: ContractAddress,
        pub amount: u128,
        pub note_id: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    /// Internal function for testing: creates a note with the given encrypted amount.
    #[generate_trait]
    pub impl MockPrivacyInternalImpl of MockPrivacyInternalTrait {
        fn _create_note(ref self: ContractState, note: EncNote) {
            self.notes.write(note.id, note.enc_amount);
            self.emit(NoteCreated { note_id: note.id, enc_amount: note.enc_amount });
        }
    }

    #[abi(embed_v0)]
    impl MockPrivacyViewsImpl of IViews<ContractState> {
        fn channel_exists(self: @ContractState, channel_id: felt252) -> bool {
            false // Mock implementation - always returns false
        }

        fn get_num_of_channels(self: @ContractState, recipient_addr: ContractAddress) -> u64 {
            0 // Mock implementation - always returns zero
        }

        fn get_channel_info(
            self: @ContractState, recipient_addr: ContractAddress, channel_index: u64,
        ) -> privacy::objects::EncChannelInfo {
            privacy::objects::EncChannelInfo {
                ephemeral_pubkey: 0, enc_channel_key: 0, enc_token: 0, enc_sender_addr: 0,
            } // Mock implementation
        }

        fn get_note(self: @ContractState, note_id: felt252) -> felt252 {
            self.notes.read(note_id)
        }

        fn nullifier_exists(self: @ContractState, nullifier: felt252) -> bool {
            false // Mock implementation - always returns false
        }

        fn get_public_key(self: @ContractState, user_addr: ContractAddress) -> felt252 {
            0 // Mock implementation - always returns zero
        }
    }

    #[abi(embed_v0)]
    impl MockPrivacyServerImpl of IServer<ContractState> {
        fn deposit(
            ref self: ContractState,
            user_addr: ContractAddress,
            token: ContractAddress,
            amount: u128,
            note: EncNote,
        ) {
            // Transfer tokens from caller to this contract
            let caller = starknet::get_caller_address();
            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            token_dispatcher
                .checked_transfer_from(
                    sender: caller,
                    recipient: starknet::get_contract_address(),
                    amount: amount.into(),
                );

            // Store the note
            self.notes.write(note.id, note.enc_amount);

            // Emit event
            self.emit(DepositExecuted { user_addr, token, amount, note_id: note.id });
        }

        fn open_channel(
            ref self: ContractState,
            recipient_addr: ContractAddress,
            enc_channel_info: privacy::objects::EncChannelInfo,
            channel_id: felt252,
        ) { // Mock implementation - no-op
        }

        fn register(ref self: ContractState, public_key: felt252) { // Mock implementation - no-op
        }

        fn replace_public_key(
            ref self: ContractState, public_key: felt252,
        ) { // Mock implementation - no-op
        }

        fn transfer(
            ref self: ContractState,
            nullifiers: core::array::Span<felt252>,
            new_notes: core::array::Span<EncNote>,
        ) { // Mock implementation - no-op
        }

        fn withdraw(
            ref self: ContractState,
            recipient_addr: ContractAddress,
            token: ContractAddress,
            amount: u128,
            nullifier: felt252,
        ) { // Mock implementation - no-op
        }
    }
}
