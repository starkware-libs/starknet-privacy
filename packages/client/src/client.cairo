#[starknet::contract]
pub mod Client {
    use client::errors as Errors;
    use client::interface::IClient;
    use client::objects::{EncryptedNote, NewNote, NotePath};
    use client::utils::{encrypt_channel_info, hash};
    use core::num::traits::Zero;
    use server::objects::EncChannelInfo;
    use starknet::ContractAddress;
    use starknet::storage::StoragePointerWriteAccess;

    #[storage]
    struct Storage {
        /// Address of the server contract.
        server: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState, server: ContractAddress) {
        assert(server.is_non_zero(), Errors::ZERO_SERVER);
        self.server.write(server);
    }

    #[abi(embed_v0)]
    pub impl ClientImpl of IClient<ContractState> {
        fn open_channel(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            recipient_addr: ContractAddress,
            token: ContractAddress,
            random: felt252,
        ) -> (ContractAddress, EncChannelInfo, felt252) {
            // TODO: Remove assert not zero for sender_addr, sender_private_key, recipient_addr?
            // (will fail in the registration check).
            assert(sender_addr.is_non_zero(), Errors::ZERO_SENDER_ADDR);
            assert(sender_private_key.is_non_zero(), Errors::ZERO_SENDER_PRIVATE_KEY);
            assert(recipient_addr.is_non_zero(), Errors::ZERO_RECIPIENT_ADDR);
            assert(token.is_non_zero(), Errors::ZERO_TOKEN);
            assert(random.is_non_zero(), Errors::ZERO_RANDOM);

            // TODO: Verify sender signature on TX.

            // TODO: Assert sender is registered with the given private key. Use error
            // SENDER_NOT_AUTHENTICATED.
            // TODO: Read recipient public key from server and assert it is not zero. Use error
            // RECIPIENT_NOT_REGISTERED.
            let recipient_pubkey = 1;

            let channel_key = hash(
                [
                    sender_addr.into(), sender_private_key, recipient_addr.into(), recipient_pubkey,
                    token.into(),
                ]
                    .span(),
            );
            let enc_channel_info = encrypt_channel_info(
                ephemeral_scalar: random, :recipient_pubkey, :channel_key, :token, :sender_addr,
            );
            let channel_id = hash([channel_key].span());

            (recipient_addr, enc_channel_info, channel_id)
        }

        fn transfer(
            self: @ContractState,
            owner: ContractAddress,
            private_key: felt252,
            notes_to_use: Span<NotePath>,
            notes_to_create: Span<NewNote>,
        ) -> (Span<felt252>, Span<EncryptedNote>) {
            assert(!notes_to_use.is_empty(), Errors::NO_NOTES_TO_USE);
            assert(!notes_to_create.is_empty(), Errors::NO_NOTES_TO_CREATE);

            // TODO: Verify owner signature on TX.

            let (nullifiers, consumed_sum) = self.use_notes(:owner, :private_key, :notes_to_use);
            let (new_notes, created_sum) = self.create_notes(:notes_to_create);

            // TODO: Consider multi-token support (sum per token).
            // TODO: Implement test to catch this error.
            // TODO: Verify the tokens match in all notes.
            assert(consumed_sum == created_sum, Errors::NOTE_SUM_MISMATCH);

            (nullifiers, new_notes)
        }
    }

    #[generate_trait]
    impl ClientInternalImpl of ClientInternalTrait {
        fn use_notes(
            self: @ContractState,
            owner: ContractAddress,
            private_key: felt252,
            notes_to_use: Span<NotePath>,
        ) -> (Span<felt252>, u256) {
            // TODO: Verify notes exist in server storage.
            // TODO: Sum note amounts.
            // TODO: Verify tokens match.
            // TODO: Return nullifiers span and amount sum.

            ([].span(), Zero::zero())
        }

        fn create_notes(
            self: @ContractState, notes_to_create: Span<NewNote>,
        ) -> (Span<EncryptedNote>, u256) {
            for note in notes_to_create {
                assert(note.recipient_addr.is_non_zero(), Errors::ZERO_RECIPIENT_ADDR);
                assert(note.token.is_non_zero(), Errors::ZERO_TOKEN);
                assert(note.amount.is_non_zero(), Errors::ZERO_AMOUNT);
                // TODO: Verify notes are sequential in server storage.
            // TODO: Sum note amounts.
            // TODO: Verify tokens match.
            }
            // TODO: Return new notes span and amount sum.

            ([].span(), Zero::zero())
        }
    }
}
