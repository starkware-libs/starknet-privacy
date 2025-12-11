#[starknet::contract]
pub mod Client {
    use client::errors as Errors;
    use client::interface::IClient;
    use client::objects::{NewNote, NotePath};
    use client::utils::{
        compute_channel_id, compute_channel_key, derive_public_key, encrypt_channel_info,
        is_canonical_key,
    };
    use core::num::traits::Zero;
    use server::interface::{IServerDispatcher, IServerDispatcherTrait};
    use server::objects::{EncChannelInfo, EncNote};
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        /// Address of the server contract.
        // TODO: Change type to Dispatcher.
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
            // TODO: Remove assert not zero for sender_addr, recipient_addr?
            // (will fail in the registration check).
            // TODO: Consider generate random instead of passing it as an argument.
            assert(sender_addr.is_non_zero(), Errors::ZERO_SENDER_ADDR);
            assert(sender_private_key.is_non_zero(), Errors::ZERO_SENDER_PRIVATE_KEY);
            assert(recipient_addr.is_non_zero(), Errors::ZERO_RECIPIENT_ADDR);
            assert(token.is_non_zero(), Errors::ZERO_TOKEN);
            assert(random.is_non_zero(), Errors::ZERO_RANDOM);

            // TODO: Verify sender signature on TX.

            // Assert sender private key is canonical.
            assert(is_canonical_key(key: sender_private_key), Errors::PRIVATE_KEY_NOT_CANONICAL);

            // Assert sender is registered with the given private key.
            let server = IServerDispatcher { contract_address: self.server.read() };
            let sender_public_key = server.get_public_key(user: sender_addr);
            assert(sender_public_key.is_non_zero(), Errors::SENDER_NOT_REGISTERED);
            assert(
                sender_public_key == derive_public_key(private_key: sender_private_key),
                Errors::SENDER_NOT_AUTHENTICATED,
            );

            // TODO: Consider passing the recipient's public key as input and moving this check to
            // the server.
            // Assert recipient is registered.
            let recipient_public_key = server.get_public_key(user: recipient_addr);
            assert(recipient_public_key.is_non_zero(), Errors::RECIPIENT_NOT_REGISTERED);

            // Compute the output values.
            let channel_key = compute_channel_key(
                :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key, :token,
            );
            let enc_channel_info = encrypt_channel_info(
                ephemeral_secret: random, :recipient_public_key, :channel_key, :token, :sender_addr,
            );
            let channel_id = compute_channel_id(:channel_key);

            (recipient_addr, enc_channel_info, channel_id)
        }

        fn transfer(
            self: @ContractState,
            owner: ContractAddress,
            owner_private_key: felt252,
            notes_to_use: Span<NotePath>,
            notes_to_create: Span<NewNote>,
        ) -> (Span<felt252>, Span<EncNote>) {
            assert(!notes_to_use.is_empty(), Errors::NO_NOTES_TO_USE);
            assert(!notes_to_create.is_empty(), Errors::NO_NOTES_TO_CREATE);

            // TODO: Verify owner signature on TX.

            let (nullifiers, consumed_sum) = self
                .use_notes(:owner, :owner_private_key, :notes_to_use);
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
            owner_private_key: felt252,
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
        ) -> (Span<EncNote>, u256) {
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
