use privacy::objects::{
    ClientAction, EncChannelInfo, EncSubchannelInfo, NewNote, NotePath, ServerAction,
};
use starknet::ContractAddress;

// TODO: Use same naming convention for the functions. (owner/sender,
// private_key/sender_private_key, etc).
// TODO: Remove params constraints from the Parameters section (constraints should be in the
// Preconditions section).
// TODO: Move return values to the Returns section and add links to ServerAction enum and actions
// variants.
// TODO: Fix enum varients links in the documentation.
// TODO: Fix error links and remove internal errors from the documentation.
#[starknet::interface]
pub trait IClient<T> {
    /// Compiles client actions into server actions that can be executed by the server.
    ///
    /// This function processes a span of [`ClientAction`](privacy::objects::ClientAction) and
    /// compiles each action into the corresponding
    /// [`ServerAction`](privacy::objects::ServerAction)s that the server can execute. A single
    /// client action may compile to multiple server actions.
    ///
    /// Returns a span containing server actions:
    /// - For `Register`: [`WriteIfZero`](privacy::objects::ServerAction::WriteIfZero) verifies
    ///   that the caller's public key is not already registered (storage value is zero) and writes
    ///   the public key to storage.
    /// - For `ReplacePublicKey`: [`WriteIfNonZero`](privacy::objects::ServerAction::WriteIfNonZero)
    ///   verifies that the caller has already registered a public key (storage value is non-zero)
    ///   and writes the new public key to storage.
    /// - For `OpenChannel`: [`VerifyValue`](privacy::objects::ServerAction::VerifyValue) verifies
    ///   that the channel key is valid for the given sender and recipient,
    ///   [`WriteIfZero`](privacy::objects::ServerAction::WriteIfZero) verifies that the channel id
    ///   does not already exist (storage value is zero) and writes `true` to mark it as existing,
    ///   [`AppendToVec`](privacy::objects::ServerAction::AppendToVec) stores the encrypted channel
    ///   info.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`) - The address of the user executing the actions. Must not
    /// be zero.
    /// - `client_actions` (`Span<`[`ClientAction`](privacy::objects::ClientAction)`>`) - The list
    ///   of client actions to compile.
    ///
    /// #### Returns
    /// - (`Span<`[`ServerAction`](privacy::objects::ServerAction)`>`) - A span containing the
    ///   server actions compiled from the input client actions.
    ///
    /// #### Preconditions
    /// - `user_addr` must not be zero.
    /// - `Register`:
    ///   - The `user_public_key` must not be zero.
    /// - `ReplacePublicKey`:
    ///   - The `user_public_key` must not be zero.
    ///   - The caller must have already registered a public key.
    /// - `OpenChannel`:
    ///   - All inputs must be non-zero.
    ///   - The `sender_private_key` must be canonical.
    ///   - The `recipient_addr` must be registered in the server.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`ZERO_USER_ADDR`](privacy::errors::client_errors::ZERO_USER_ADDR): Thrown if `user_addr`
    /// is zero.
    /// - [`ZERO_PUBLIC_KEY`](privacy::errors::client_errors::ZERO_PUBLIC_KEY): Thrown if a
    /// `Register` or `ReplacePublicKey` action contains a zero public key.
    ///
    /// #### Access Control
    /// - TODO
    fn compile_client_actions(
        self: @T, user_addr: ContractAddress, client_actions: Span<ClientAction>,
    ) -> Span<ServerAction>;

    /// Validates `notes_to_create` are a valid redistribution of funds from `notes_to_use`.
    ///
    /// A transfer consists of nullifying existing notes owned by `owner_addr` and creating
    /// new notes for the recipients.
    /// The owner can be one of the recipients.
    ///
    /// Returns a span containing actions to execute the transfer:
    /// 1. `WriteIfZero` actions (one per note in `notes_to_use`) - Marks the nullifiers of consumed
    ///    notes to prevent double-spending. Verifies that each nullifier doesn't already exist
    ///    (storage value is zero) and writes `true` to mark it as used.
    /// 2. `WriteIfZero` actions (one per note in `notes_to_create`) - Stores the encrypted notes
    ///    for the recipients. Verifies that each note doesn't already exist
    ///    (storage value is zero) and writes the encrypted note value to storage.
    ///
    /// #### Parameters
    /// - `owner_addr` (`ContractAddress`) - The owner's address. Must not be zero.
    /// - `owner_private_key` (`felt252`) - The owner's private key. Must not be zero.
    /// - `notes_to_use` (`Span<`[`NotePath`](privacy::objects::NotePath)`>`) - The notes that are
    /// consumed as part of the transfer.
    /// Must not be empty.
    /// - `notes_to_create` (`Span<`[`NewNote`](privacy::objects::NewNote)`>`) - The notes that are
    /// created as a result of the transfer. Must not be empty and have non-zero `recipient_addr`s,
    /// `token`s, and `amount`s.
    ///
    /// #### Returns
    /// - (`Span<ServerAction>`) - A span containing the WriteIfZero actions to execute the
    /// transfer.
    ///
    /// #### Preconditions
    /// - `owner_addr`, `owner_private_key` must not be zero.
    /// - `notes_to_use`, `notes_to_create` must not be empty.
    /// - `notes_to_use` use valid channel keys, tokens, and note indexes of the owner's existing
    /// notes.
    /// - `notes_to_create` have non-zero `recipient_addr`s, `token`s, and `amount`s.
    /// - Each recipient is registered in the server.
    /// - A channel exists from `owner_addr` to each recipient of the given token.
    /// - `notes_to_create` use valid (sequential) `index`s within the channel.
    /// - `owner_private_key` matches the `owner_addr`'s public key defined as part of the channels.
    /// - The sum of the amounts of `notes_to_create` equals the sum of the amounts of
    /// `notes_to_use`.
    /// - All notes are in the same token.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`ZERO_OWNER_ADDR`](privacy::errors::ZERO_OWNER_ADDR): Thrown if `owner_addr` is zero.
    /// - [`ZERO_OWNER_PRIVATE_KEY`](privacy::errors::ZERO_OWNER_PRIVATE_KEY): Thrown if
    /// `owner_private_key` is zero.
    /// - [`NO_NOTES_TO_USE`](privacy::errors::NO_NOTES_TO_USE): Thrown if `notes_to_use` is empty.
    /// - [`NO_NOTES_TO_CREATE`](privacy::errors::NO_NOTES_TO_CREATE): Thrown if `notes_to_create`
    /// is empty.
    /// - [`ZERO_CHANNEL_KEY`](privacy::errors::ZERO_CHANNEL_KEY): Thrown if there's a note to be
    /// used with zero as the channel key.
    /// - [`NOTE_NOT_FOUND`](privacy::errors::NOTE_NOT_FOUND): Thrown if a note to be used is not
    /// found.
    /// - [`ZERO_RECIPIENT_ADDR`](privacy::errors::ZERO_RECIPIENT_ADDR): Thrown if there's a note to
    /// be created with zero as the recipient.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if there's a note to be used/created
    /// with zero as the token.
    /// - [`ZERO_AMOUNT`](privacy::errors::ZERO_AMOUNT): Thrown if there's a note to be created with
    /// zero as the amount.
    /// - [`RECIPIENT_NOT_REGISTERED`](privacy::errors::RECIPIENT_NOT_REGISTERED): Thrown if a
    /// recipient is not registered in the server.
    /// - [`INVALID_SUBCHANNEL`](privacy::errors::INVALID_SUBCHANNEL): Thrown if there is no valid
    /// subchannel for a note to be used/created.
    /// - [`INDEX_NOT_SEQUENTIAL`](privacy::errors::INDEX_NOT_SEQUENTIAL): Thrown if a
    /// note index is not sequential for one of the `notes_to_create`.
    /// - [`NOTE_SUM_MISMATCH`](privacy::errors::NOTE_SUM_MISMATCH): Thrown if there's a mismatch
    /// between the spent funds and the received funds.
    /// - [`ZERO_NULLIFIER`](privacy::errors::ZERO_NULLIFIER): Thrown if a calculated nullifier is
    /// zero.
    /// - [`ZERO_NOTE_ID`](privacy::errors::ZERO_NOTE_ID): Thrown if a calculated note id is zero.
    /// - [`ZERO_ENC_NOTE_VALUE`](privacy::errors::ZERO_ENC_NOTE_VALUE): Thrown if a calculated note
    /// encrypted amount is zero.
    /// - [`ACTIONS_LENGTH_MISMATCH`](privacy::errors::ACTIONS_LENGTH_MISMATCH): Thrown if the
    /// number of actions doesn't match the number of notes to use or the number of notes to create.
    ///
    /// #### Access Control
    /// - Can be called by anyone, but the transaction must be signed by `owner_addr`.
    fn transfer(
        self: @T,
        owner_addr: ContractAddress,
        owner_private_key: felt252,
        notes_to_use: Span<NotePath>,
        notes_to_create: Span<NewNote>,
    ) -> Span<ServerAction>;

    /// Generates a deposit transaction to create a new note for the owner.
    ///
    /// Prepares the inputs for the server's `deposit` function.
    /// `new_note.recipient_addr` is considered the owner, and used as the address to transfer the
    /// deposit from.
    /// The function encrypts a new note for the owner based on the provided details.
    ///
    /// Returns a span containing actions to execute the deposit:
    /// 1. `WriteIfZero` - Stores the encrypted note for the owner. Verifies that the note
    ///    doesn't already exist (storage value is zero) and writes the encrypted note value to
    ///    storage.
    /// 2. `TransferFrom` - Transfers the deposit from the owner to the contract.
    ///
    /// #### Parameters
    /// - `owner_private_key` (`felt252`) - The owner's private key. Must not be zero.
    /// - `new_note` ([`NewNote`](privacy::objects::NewNote)) - The details of the note to be
    /// created.
    /// `new_note.recipient_addr`, `new_note.token`, and `new_note.amount` must not be zero.
    ///
    /// #### Returns
    /// - (`Span<ServerAction>`) - A span containing the WriteIfZero and TransferFrom actions to
    /// execute the deposit.
    ///
    /// #### Preconditions
    /// - A self-channel exists for `new_note.recipient_addr` with `new_note.token` for
    /// `owner_private_key`'s public key.
    /// - `owner_private_key` matches the `new_note.recipient_addr`'s public key.
    /// - `new_note.index` is sequential within the channel.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`ZERO_OWNER_PRIVATE_KEY`](privacy::errors::ZERO_OWNER_PRIVATE_KEY): Thrown if
    /// `owner_private_key` is zero.
    /// - [`ZERO_RECIPIENT_ADDR`](privacy::errors::ZERO_RECIPIENT_ADDR): Thrown if
    /// `new_note.recipient_addr` is zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if `new_note.token` is zero.
    /// - [`ZERO_AMOUNT`](privacy::errors::ZERO_AMOUNT): Thrown if `new_note.amount` is zero.
    /// - [`RECIPIENT_NOT_REGISTERED`](privacy::errors::RECIPIENT_NOT_REGISTERED): Thrown if
    /// `new_note.recipient_addr` is not registered in the server.
    /// - [`INVALID_SUBCHANNEL`](privacy::errors::INVALID_SUBCHANNEL): Thrown if a self-channel for
    /// `new_note.recipient_addr` with `new_note.token` doesn't exist with the given
    /// `owner_private_key`.
    /// - [`INDEX_NOT_SEQUENTIAL`](privacy::errors::INDEX_NOT_SEQUENTIAL): Thrown if
    /// `new_note.index` is not sequential (`new_note.index != 0` and `new_note.index - 1` does not
    /// exist).
    /// - [`ZERO_NOTE_ID`](privacy::errors::ZERO_NOTE_ID): Thrown if a calculated note id is zero.
    /// - [`ZERO_ENC_NOTE_VALUE`](privacy::errors::ZERO_ENC_NOTE_VALUE): Thrown if a calculated note
    /// encrypted amount is zero.
    ///
    /// #### Access Control
    /// - TODO
    fn deposit(self: @T, owner_private_key: felt252, new_note: NewNote) -> Span<ServerAction>;

    /// Validates a withdrawal of a note and generates the nullifier and withdrawal details for the
    /// server.
    ///
    /// Only a single note can be withdrawn at a time, and it's entire amount must be withdrawn.
    ///
    /// Returns a span containing actions to execute the withdrawal:
    /// 1. `WriteIfZero` - Marks the nullifier to prevent double-spending. Verifies that the
    ///    nullifier doesn't already exist (storage value is zero) and writes `true` to mark it as
    ///    used.
    /// 2. `TransferTo` - Transfers the withdrawn funds to the withdrawal target.
    ///
    /// #### Parameters
    /// - `owner_addr` (`ContractAddress`) - The address of the note owner. Must not be zero.
    /// - `owner_private_key` (`felt252`) - The owner's private key. Must not be zero.
    /// - `withdrawal_target` (`ContractAddress`) - The address where the funds will be withdrawn
    /// to. Must not be zero.
    /// - `note_to_withdraw` ([`NotePath`](privacy::objects::NotePath)) - The note to be withdrawn.
    ///
    /// #### Returns
    /// - (`Span<ServerAction>`) - A span containing the WriteIfZero and TransferTo actions to
    /// execute the withdrawal.
    ///
    /// #### Preconditions
    /// - `owner_addr`, `owner_private_key`, and `withdrawal_target` are not zero.
    /// - `owner_private_key`` matches the `owner_addr`'s public key that composes the note's
    /// channel.
    /// - The note exists and belongs to the owner.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`ZERO_OWNER_ADDR`](privacy::errors::ZERO_OWNER_ADDR): Thrown if `owner_addr` is zero.
    /// - [`ZERO_OWNER_PRIVATE_KEY`](privacy::errors::ZERO_OWNER_PRIVATE_KEY): Thrown if
    /// `owner_private_key` is zero.
    /// - [`ZERO_WITHDRAWAL_TARGET`](privacy::errors::ZERO_WITHDRAWAL_TARGET): Thrown if
    /// `withdrawal_target` is zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the `note_to_withdraw.token` is
    /// zero.
    /// - [`ZERO_CHANNEL_KEY`](privacy::errors::ZERO_CHANNEL_KEY): Thrown if the
    /// `note_to_withdraw.channel_key` is zero.
    /// - [`INVALID_SUBCHANNEL`](privacy::errors::INVALID_SUBCHANNEL): Thrown if the derived
    /// subchannel is not found.
    /// - [`NOTE_NOT_FOUND`](privacy::errors::NOTE_NOT_FOUND): Thrown if the note is not found.
    /// - [`ZERO_NULLIFIER`](privacy::errors::ZERO_NULLIFIER): Thrown if a calculated nullifier is
    /// zero.
    ///
    /// #### Access Control
    /// - TODO
    fn withdraw(
        self: @T,
        owner_addr: ContractAddress,
        owner_private_key: felt252,
        withdrawal_target: ContractAddress,
        note_to_withdraw: NotePath,
    ) -> Span<ServerAction>;
}

#[starknet::interface]
pub trait IServer<T> {
    // TODO: Add ZERO_VALUE in reverts.
    /// Executes a list of actions atomically.
    ///
    /// #### Parameters
    /// - `actions` (`Span<ServerAction>`): The list of actions to execute.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - TODO
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if
    /// `WriteIfZero` action is executed and the value at the specified storage path already exists.
    /// - [`INSUFFICIENT_BALANCE`]: Thrown if `TransferFrom` action is executed and the sender has
    /// insufficient balance.
    /// - [`INSUFFICIENT_ALLOWANCE`]: Thrown if `TransferFrom` action is executed and the sender has
    /// insufficient allowance.
    ///
    /// #### Access Control
    /// - TODO
    fn execute_actions(ref self: T, actions: Span<ServerAction>);
}

#[starknet::interface]
pub trait IViews<T> {
    /// Checks if a channel exists.
    ///
    /// #### Parameters
    /// - `channel_id` (`felt252`): The id of the channel.
    ///
    /// #### Returns
    /// (`bool`): True if the channel exists in the contract, false otherwise.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn channel_exists(self: @T, channel_id: felt252) -> bool;

    /// Returns the number of open channels for the given (recipient_addr, recipient_public_key)
    /// pair.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient of the channels.
    /// - `recipient_public_key` (`felt252`): The public key of the recipient to list channels for.
    ///
    /// #### Returns
    /// (`u64`): The number of the open channels for the recipient.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn get_num_of_channels(
        self: @T, recipient_addr: ContractAddress, recipient_public_key: felt252,
    ) -> u64;

    // TODO: add "Index out of bounds" in reverts?
    /// Returns the encrepted channel information for a given (recipient_addr, recipient_public_key)
    /// pair and channel index.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient.
    /// - `recipient_public_key` (`felt252`): The public key of the recipient to get channel info
    /// for.
    /// - `channel_index` (`u64`): The index of the channel within the recipient's channel vector.
    ///
    /// #### Returns
    /// (`EncChannelInfo`): The encrypted channel information.
    ///
    /// #### Preconditions
    /// - `channel_index` must be a valid index within the `recipient_addr`'s channel vector.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn get_channel_info(
        self: @T,
        recipient_addr: ContractAddress,
        recipient_public_key: felt252,
        channel_index: u64,
    ) -> EncChannelInfo;

    /// Checks if a subchannel exists.
    ///
    /// #### Parameters
    /// - `subchannel_id` (`felt252`): The id of the subchannel.
    ///
    /// #### Returns
    /// (`bool`): True if the subchannel exists in the contract, false otherwise.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn subchannel_exists(self: @T, subchannel_id: felt252) -> bool;

    /// Returns the encrepted subchannel information for a given subchannel key.
    ///
    /// #### Parameters
    /// - `subchannel_key` (`felt252`): The key of the subchannel.
    ///
    /// #### Returns
    /// (`EncSubchannelInfo`): The encrypted subchannel information, or a zero struct if the
    /// subchannel does not exist.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn get_subchannel_info(self: @T, subchannel_key: felt252) -> EncSubchannelInfo;

    /// Returns the encrypted note value for a given note id.
    ///
    /// #### Parameters
    /// - `note_id` (`felt252`): The id of the note.
    ///
    /// #### Returns
    /// (`felt252`): The encrypted note value.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn get_note(self: @T, note_id: felt252) -> felt252;

    /// Checks if a nullifier exists.
    ///
    /// #### Parameters
    /// - `nullifier` (`felt252`): The nullifier.
    ///
    /// #### Returns
    /// (`bool`): True if the nullifier exists in the contract, false otherwise.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn nullifier_exists(self: @T, nullifier: felt252) -> bool;

    /// Returns the registered public viewing key of the given user address.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address whose public key is being queried.
    ///
    /// #### Returns
    /// - (`felt252`): The public key associated with the user, or zero if not registered.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn get_public_key(self: @T, user_addr: ContractAddress) -> felt252;
}
