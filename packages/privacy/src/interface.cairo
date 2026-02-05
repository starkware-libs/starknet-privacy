use privacy::actions::{ClientAction, ServerAction};
use privacy::objects::{
    EncChannelInfo, EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo, Note,
};
use starknet::ContractAddress;

#[starknet::interface]
pub trait IClient<T> {
    /// Processes client actions and sends the compiled server actions as a message to L1.
    ///
    /// This function validates execution context, processes
    /// `Span<`[`ClientAction`](privacy::actions::ClientAction)`>`, compiles each action into
    /// corresponding [`ServerAction`](privacy::actions::ServerAction)s and sends the result to L1.
    /// A single client action may compile to multiple server actions.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address of the user executing the actions.
    /// - `user_private_key` (`felt252`): The private key of the user executing the actions.
    /// - `client_actions` (`Span<`[`ClientAction`](privacy::actions::ClientAction)`>`): The list of
    /// client actions to compile.
    ///   Each [`ClientAction`](privacy::actions::ClientAction) variant has the following purpose:
    ///   - [`SetViewingKey`](privacy::actions::ClientAction::SetViewingKey): Register a user with a
    ///   viewing key.
    ///   - [`OpenChannel`](privacy::actions::ClientAction::OpenChannel): Open a new channel from
    ///   the user to a recipient.
    ///   - [`OpenSubchannel`](privacy::actions::ClientAction::OpenSubchannel): Open a new
    ///   subchannel (of specific token) from the user to a recipient.
    ///   - [`Deposit`](privacy::actions::ClientAction::Deposit): Deposit funds into the contract.
    ///   - [`UseNote`](privacy::actions::ClientAction::UseNote): Uses up a note (creates a
    ///   nullifier for it).
    ///   - [`CreateNote`](privacy::actions::ClientAction::CreateNote): Creates a new note based on
    ///   the specified input.
    ///   - [`Withdraw`](privacy::actions::ClientAction::Withdraw): Withdraw funds from the
    ///   contract.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - The caller address must be zero.
    /// - The TX version must be >= 3.
    /// - The effective fee of the transaction is zero (i.e. `tip` and `resource_bounds`).
    /// - `user_addr` must not be zero.
    /// - `user_private_key` must not be zero and must be canonical.
    /// - The TX signature must be valid for `user_addr`.
    /// - `client_actions` must be valid sequential actions to execute on the current state of the
    /// contract.
    /// - `client_actions` must be ordered in the order of the
    /// [`ClientAction`](privacy::actions::ClientAction) enum:
    /// [`SetViewingKey`](privacy::actions::ClientAction::SetViewingKey),
    /// [`OpenChannel`](privacy::actions::ClientAction::OpenChannel),
    /// [`OpenSubchannel`](privacy::actions::ClientAction::OpenSubchannel),
    /// [`Deposit`](privacy::actions::ClientAction::Deposit),
    /// [`UseNote`](privacy::actions::ClientAction::UseNote),
    /// [`CreateNote`](privacy::actions::ClientAction::CreateNote),
    /// [`Withdraw`](privacy::actions::ClientAction::Withdraw).
    /// - At most one [`SetViewingKey`](privacy::actions::ClientAction::SetViewingKey) action is
    /// allowed per transaction.
    /// - At least one privacy-related action must be included
    /// ([`Deposit`](privacy::actions::ClientAction::Deposit) and
    /// [`Withdraw`](privacy::actions::ClientAction::Withdraw) are not privacy-related actions).
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Messages to L1
    /// - A message to L1 is sent with zero `to_address` and a serialized span of
    /// [`ServerAction`](privacy::actions::ServerAction)s which are the result of the client actions
    /// in the input.
    ///
    /// #### Reverts
    /// - [`NON_ZERO_CALLER`](privacy::errors::NON_ZERO_CALLER): Thrown if the caller address is not
    /// zero.
    /// - [`INVALID_TX_VERSION`](privacy::errors::INVALID_TX_VERSION): Thrown if the TX version is
    /// not >= 3.
    /// - [`NON_ZERO_TIP`](privacy::errors::NON_ZERO_TIP): Thrown if the transaction tip is not
    /// zero.
    /// - [`NON_ZERO_RESOURCE_PRICE`](privacy::errors::NON_ZERO_RESOURCE_PRICE): Thrown if the
    /// transaction resource prices are not zero.
    /// - [`INVALID_SIGNATURE`](privacy::errors::INVALID_SIGNATURE): Thrown if the TX signature is
    /// invalid (The TX signature should be of `user_addr` who is executing the actions).
    /// - See [`execute_and_panic`](privacy::interface::IClient::execute_and_panic) for errors that
    /// occur during client action processing.
    ///
    /// #### Access Control
    /// - Only zero caller address.
    ///
    /// #### Notes
    /// - This function internally calls [`execute_view`](privacy::interface::IClient::execute_view)
    /// to compile the client actions into server actions.
    /// - See [`execute_view`](privacy::interface::IClient::execute_view) Returns section for
    /// details on which server actions each client action produces.
    /// - This function does not change the state of the contract.
    fn __execute__(
        ref self: T,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    );

    /// Processes client actions and panics with the compiled server actions or an error.
    ///
    /// This function processes client actions and always panics with either the
    /// serialized server actions (wrapped with
    /// [`OK_WRAPPER`](privacy::utils::constants::OK_WRAPPER)) or an error. It is called by
    /// [`execute_view`](privacy::interface::IClient::execute_view) via syscall to capture the
    /// result.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address of the user executing the actions.
    /// - `user_private_key` (`felt252`): The private key of the user executing the actions.
    /// - `client_actions` (`Span<`[`ClientAction`](privacy::actions::ClientAction)`>`): The list of
    /// client actions to compile. See [`__execute__`](privacy::interface::IClient::__execute__) for
    /// more details.
    ///
    /// #### Returns
    /// Always panics, on success it panics with the serialized server actions wrapped with
    /// [`OK_WRAPPER`](privacy::utils::constants::OK_WRAPPER) as the panic data.
    ///
    /// #### Preconditions
    /// - `user_addr` must not be zero.
    /// - `user_private_key` must not be zero and must be canonical.
    /// - `client_actions` must be valid sequential actions to execute on the current state of the
    /// contract.
    /// - See [`__execute__`](privacy::interface::IClient::__execute__) for additional constraints
    /// on `client_actions`.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Messages to L1
    /// None
    ///
    /// #### Reverts
    /// - On success, panic with the serialized server actions wrapped with
    /// [`OK_WRAPPER`](privacy::utils::constants::OK_WRAPPER).
    /// - [`ZERO_USER_ADDR`](privacy::errors::ZERO_USER_ADDR): Thrown if `user_addr` is zero.
    /// - [`ZERO_PRIVATE_KEY`](privacy::errors::ZERO_PRIVATE_KEY): Thrown if `user_private_key` is
    /// zero.
    /// - [`PRIVATE_KEY_NOT_CANONICAL`](privacy::errors::PRIVATE_KEY_NOT_CANONICAL): Thrown if
    /// `user_private_key` is not in canonical form.
    /// - [`ACTIONS_OUT_OF_ORDER`](privacy::errors::ACTIONS_OUT_OF_ORDER): Thrown if
    /// `client_actions` is not ordered correctly.
    /// - [`NO_PRIVACY_ACTIONS`](privacy::errors::NO_PRIVACY_ACTIONS): Thrown if `client_actions`
    /// does not include any privacy-related actions.
    /// - [`FINAL_BALANCE_MUST_BE_ZERO`](privacy::errors::FINAL_BALANCE_MUST_BE_ZERO): Thrown if
    /// token balances are not zero after all actions are processed.
    ///
    /// **Errors for [`SetViewingKey`](privacy::actions::ClientAction::SetViewingKey) action:**
    /// - [`ZERO_RANDOM`](privacy::errors::ZERO_RANDOM): Thrown if the random value is zero.
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the user is already
    /// registered.
    ///
    /// **Errors for [`OpenChannel`](privacy::actions::ClientAction::OpenChannel) action:**
    /// - [`ZERO_RECIPIENT_ADDR`](privacy::errors::ZERO_RECIPIENT_ADDR): Thrown if the recipient
    /// address is zero.
    /// - [`ZERO_RECIPIENT_PUBLIC_KEY`](privacy::errors::ZERO_RECIPIENT_PUBLIC_KEY): Thrown if the
    /// recipient public key is zero.
    /// - [`ZERO_RANDOM`](privacy::errors::ZERO_RANDOM): Thrown if the random value is zero.
    /// - [`SENDER_NOT_REGISTERED`](privacy::errors::SENDER_NOT_REGISTERED): Thrown if the sender is
    /// not registered with a viewing key.
    /// - [`SENDER_NOT_AUTHENTICATED`](privacy::errors::SENDER_NOT_AUTHENTICATED): Thrown if the
    /// sender's public key does not match the derived public key from the private key.
    /// - [`INDEX_NOT_SEQUENTIAL`](privacy::errors::INDEX_NOT_SEQUENTIAL): Thrown if the channel
    /// index is not sequential (i.e. the previous channel does not exist).
    /// - [`VALUE_MISMATCH`](privacy::errors::VALUE_MISMATCH): Thrown if the recipient's public key
    /// in storage does not match the provided public key.
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the channel already exists
    /// or the outgoing channel index is already used.
    ///
    /// **Errors for [`OpenSubchannel`](privacy::actions::ClientAction::OpenSubchannel) action:**
    /// - [`ZERO_RECIPIENT_ADDR`](privacy::errors::ZERO_RECIPIENT_ADDR): Thrown if the recipient
    /// address is zero.
    /// - [`ZERO_RECIPIENT_PUBLIC_KEY`](privacy::errors::ZERO_RECIPIENT_PUBLIC_KEY): Thrown if the
    /// recipient public key is zero.
    /// - [`ZERO_CHANNEL_KEY`](privacy::errors::ZERO_CHANNEL_KEY): Thrown if the channel key is
    /// zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`INVALID_CHANNEL`](privacy::errors::INVALID_CHANNEL): Thrown if the channel does not
    /// exist.
    /// - [`INDEX_NOT_SEQUENTIAL`](privacy::errors::INDEX_NOT_SEQUENTIAL): Thrown if the subchannel
    /// index is not sequential (i.e. the previous subchannel does not exist).
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the subchannel already
    /// exists or the subchannel index is already used.
    ///
    /// **Errors for [`Deposit`](privacy::actions::ClientAction::Deposit) action:**
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`ZERO_AMOUNT`](privacy::errors::ZERO_AMOUNT): Thrown if the deposit amount is zero.
    ///
    /// **Errors for [`UseNote`](privacy::actions::ClientAction::UseNote) action:**
    /// - [`ZERO_CHANNEL_KEY`](privacy::errors::ZERO_CHANNEL_KEY): Thrown if the channel key is
    /// zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`SUBCHANNEL_NOT_FOUND`](privacy::errors::SUBCHANNEL_NOT_FOUND): Thrown if the subchannel
    /// does not exist.
    /// - [`NOTE_NOT_FOUND`](privacy::errors::NOTE_NOT_FOUND): Thrown if the note does not exist.
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the nullifier already
    /// exists (the note already spent before).
    ///
    /// **Errors for [`CreateNote`](privacy::actions::ClientAction::CreateNote) action:**
    /// - [`ZERO_RECIPIENT_ADDR`](privacy::errors::ZERO_RECIPIENT_ADDR): Thrown if the recipient
    /// address is zero.
    /// - [`ZERO_RECIPIENT_PUBLIC_KEY`](privacy::errors::ZERO_RECIPIENT_PUBLIC_KEY): Thrown if the
    /// recipient public key is zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`SALT_TOO_SMALL`](privacy::errors::SALT_TOO_SMALL): Thrown if the salt < 2.
    /// - [`SALT_EXCEEDS_120_BITS`](privacy::errors::SALT_EXCEEDS_120_BITS): Thrown if the salt
    /// exceeds 120 bits.
    /// - [`SUBCHANNEL_NOT_FOUND`](privacy::errors::SUBCHANNEL_NOT_FOUND): Thrown if the subchannel
    /// does not exist.
    /// - [`INDEX_NOT_SEQUENTIAL`](privacy::errors::INDEX_NOT_SEQUENTIAL): Thrown if the note index
    /// is not sequential (i.e. the previous note does not exist).
    /// - [`NEGATIVE_INTERMEDIATE_BALANCE`](privacy::errors::NEGATIVE_INTERMEDIATE_BALANCE): Thrown
    /// if token balances become negative during execution.
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the note id already exists.
    ///
    /// **Errors for [`Withdraw`](privacy::actions::ClientAction::Withdraw) action:**
    /// - [`ZERO_WITHDRAWAL_TARGET`](privacy::errors::ZERO_WITHDRAWAL_TARGET): Thrown if the
    /// withdrawal target address is zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`ZERO_AMOUNT`](privacy::errors::ZERO_AMOUNT): Thrown if the withdrawal amount is zero.
    /// - [`ZERO_RANDOM`](privacy::errors::ZERO_RANDOM): Thrown if the random value is zero.
    /// - [`NEGATIVE_INTERMEDIATE_BALANCE`](privacy::errors::NEGATIVE_INTERMEDIATE_BALANCE): Thrown
    /// if token balances become negative during execution.
    ///
    /// #### Access Control
    /// - Any address can call this function.
    ///
    /// #### Notes
    /// - This function always panics. On success, it panics with serialized server actions wrapped
    /// with [`OK_WRAPPER`](privacy::utils::constants::OK_WRAPPER). On error, it panics with the
    /// error.
    /// - This function ensures that the contract state cannot be modified by client's functions.
    fn execute_and_panic(
        ref self: T,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    );

    /// Processes client actions and returns the compiled server actions (without sending to L1).
    ///
    /// This function processes a span of [`ClientAction`](privacy::actions::ClientAction) and
    /// compiles each action into corresponding [`ServerAction`](privacy::actions::ServerAction)s.
    /// It internally calls [`execute_and_panic`](privacy::interface::IClient::execute_and_panic)
    /// via syscall to capture the result. Unlike
    /// [`__execute__`](privacy::interface::IClient::__execute__), this function does not send
    /// messages to L1 and does not validate execution context (caller address, TX version, fees).
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address of the user executing the actions.
    /// - `user_private_key` (`felt252`): The private key of the user executing the actions.
    /// - `client_actions` (`Span<`[`ClientAction`](privacy::actions::ClientAction)`>`): The list of
    /// client actions to compile, see [`__execute__`](privacy::interface::IClient::__execute__) for
    /// more details.
    ///
    /// #### Returns
    /// - (`Span<`[`ServerAction`](privacy::actions::ServerAction)`>`): The compiled server actions
    /// resulting from the client actions.
    ///
    /// Each client action compiles to one or more
    /// [`ServerAction`](privacy::actions::ServerAction)s:
    ///
    /// **For [`SetViewingKey`](privacy::actions::ClientAction::SetViewingKey) action:**
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the user's public key to
    /// storage.
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the encrypted private key
    /// to storage.
    /// - [`EmitViewingKeySet`](privacy::actions::ServerAction::EmitViewingKeySet): Emits a
    /// [`ViewingKeySet`](privacy::events::ViewingKeySet) event.
    ///
    /// **For [`OpenChannel`](privacy::actions::ClientAction::OpenChannel) action:**
    /// - [`ReadAssert`](privacy::actions::ServerAction::ReadAssert): Verifies that the
    /// recipient's public key in storage matches the provided public key.
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the channel existence
    /// flag to storage.
    /// - [`AppendToVec`](privacy::actions::ServerAction::AppendToVec): Appends the encrypted
    /// channel info to the recipient's channel vector.
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the encrypted outgoing
    /// channel info to storage.
    ///
    /// **For [`OpenSubchannel`](privacy::actions::ClientAction::OpenSubchannel) action:**
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the subchannel existence
    /// flag to storage.
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the encrypted subchannel
    /// info to storage.
    ///
    /// **For [`Deposit`](privacy::actions::ClientAction::Deposit) action:**
    /// - [`TransferFrom`](privacy::actions::ServerAction::TransferFrom): Transfers tokens from the
    /// user to the contract via ERC20 `transfer_from`.
    /// - [`EmitDeposit`](privacy::actions::ServerAction::EmitDeposit): Emits a
    /// [`Deposit`](privacy::events::Deposit) event.
    ///
    /// **For [`UseNote`](privacy::actions::ClientAction::UseNote) action:**
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the nullifier to storage
    /// to mark the note as spent.
    ///
    /// **For [`CreateNote`](privacy::actions::ClientAction::CreateNote) action:**
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the encrypted note to
    /// storage.
    ///
    /// **For [`Withdraw`](privacy::actions::ClientAction::Withdraw) action:**
    /// - [`TransferTo`](privacy::actions::ServerAction::TransferTo): Transfers tokens from the
    /// contract to the withdrawal target via ERC20 `transfer`.
    /// - [`EmitWithdrawal`](privacy::actions::ServerAction::EmitWithdrawal): Emits a
    /// [`Withdrawal`](privacy::events::Withdrawal) event.
    ///
    /// #### Preconditions
    /// - `user_addr` must not be zero.
    /// - `user_private_key` must not be zero and must be canonical.
    /// - `client_actions` must be valid sequential actions to execute on the current state of the
    /// contract.
    /// - See [`__execute__`](privacy::interface::IClient::__execute__) for additional constraints
    /// on `client_actions`.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Messages to L1
    /// None
    ///
    /// #### Reverts
    /// See [`execute_and_panic`](privacy::interface::IClient::execute_and_panic) for the complete
    /// list of errors.
    ///
    /// #### Access Control
    /// - Any address can call this function.
    ///
    /// #### Notes
    /// - This function is called by [`__execute__`](privacy::interface::IClient::__execute__) to
    /// compile client actions before sending to L1.
    /// - The function internally calls
    /// [`execute_and_panic`](privacy::interface::IClient::execute_and_panic) via syscall to capture
    /// the result.
    /// - This is a view function which never changes the state.
    fn execute_view(
        self: @T,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Span<ServerAction>;

    /// An empty implementation for the TX validation, always returns valid.
    ///
    /// This function is called by the account (privacy) contract during transaction validation to
    /// check if the transaction can be executed. It always returns
    /// [`VALIDATED`](starknet::VALIDATED) to indicate that the transaction is valid.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address of the user executing the actions.
    /// - `user_private_key` (`felt252`): The private key of the user executing the actions.
    /// - `client_actions` (`Span<`[`ClientAction`](privacy::actions::ClientAction)`>`): The list of
    /// client actions to validate.
    ///
    /// #### Returns
    /// - (`felt252`): Always returns [`VALIDATED`](starknet::VALIDATED) to indicate the transaction
    /// is valid.
    ///
    /// #### Notes
    /// - This function is part of the account contract interface and is called automatically during
    /// transaction validation.
    fn __validate__(
        self: @T,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> felt252;
}

#[starknet::interface]
pub trait IServer<T> {
    /// Executes a list of server actions atomically.
    ///
    /// This function executes a span of [`ServerAction`](privacy::actions::ServerAction)s in
    /// sequence, performing storage operations, token transfers, and event emissions. All actions
    /// are executed atomically - if any action fails, the entire transaction reverts. The contract
    /// must not be paused for this function to execute.
    ///
    /// #### Parameters
    /// - `actions` (`Span<`[`ServerAction`](privacy::actions::ServerAction)`>`): The list of server
    /// actions to execute.
    ///   Each [`ServerAction`](privacy::actions::ServerAction) variant has the following purpose:
    ///   - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Verify that a storage value is
    ///   zero/empty and then write to it.
    ///   - [`AppendToVec`](privacy::actions::ServerAction::AppendToVec): Append an encrypted
    ///   channel info value to a recipient's channel vector in storage.
    ///   - [`TransferFrom`](privacy::actions::ServerAction::TransferFrom): Transfer tokens from a
    ///   user to the contract via ERC20 `transfer_from`.
    ///   - [`TransferTo`](privacy::actions::ServerAction::TransferTo): Transfer tokens from the
    ///   contract to a recipient via ERC20 `transfer`.
    ///   - [`ReadAssert`](privacy::actions::ServerAction::ReadAssert): Read and assert that a
    ///   storage value is equal to a given value.
    ///   - [`EmitViewingKeySet`](privacy::actions::ServerAction::EmitViewingKeySet): Emit a
    ///   [`ViewingKeySet`](privacy::events::ViewingKeySet) event.
    ///   - [`EmitWithdrawal`](privacy::actions::ServerAction::EmitWithdrawal): Emit a
    ///   [`Withdrawal`](privacy::events::Withdrawal) event.
    ///   - [`EmitDeposit`](privacy::actions::ServerAction::EmitDeposit): Emit a
    ///   [`Deposit`](privacy::events::Deposit) event.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - The contract must not be paused.
    /// - `proof_facts` field in the TX info must be valid.
    /// - For [`WriteOnce`](privacy::actions::ServerAction::WriteOnce) actions, the storage location
    /// must be empty (zero) before writing.
    /// - For [`ReadAssert`](privacy::actions::ServerAction::ReadAssert) actions, the storage
    /// value must match the expected value.
    /// - For [`TransferFrom`](privacy::actions::ServerAction::TransferFrom) actions, the sender
    /// must have sufficient token balance and allowance.
    ///
    /// #### Events Emitted
    /// Events are emitted based on the server actions in the input:
    /// - [`ViewingKeySet`](privacy::events::ViewingKeySet): Emitted when
    /// [`EmitViewingKeySet`](privacy::actions::ServerAction::EmitViewingKeySet) action is executed.
    /// - [`Withdrawal`](privacy::events::Withdrawal): Emitted when
    /// [`EmitWithdrawal`](privacy::actions::ServerAction::EmitWithdrawal) action is executed.
    /// - [`Deposit`](privacy::events::Deposit): Emitted when
    /// [`EmitDeposit`](privacy::actions::ServerAction::EmitDeposit) action is executed.
    ///
    /// #### Reverts
    /// **Errors for [`WriteOnce`](privacy::actions::ServerAction::WriteOnce) action:**
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the value at the specified
    /// storage path already exists (is not zero).
    ///
    /// **Errors for [`ReadAssert`](privacy::actions::ServerAction::ReadAssert) action:**
    /// - [`VALUE_MISMATCH`](privacy::errors::VALUE_MISMATCH): Thrown if the storage value does not
    /// match the expected value.
    ///
    /// **Errors for [`TransferFrom`](privacy::actions::ServerAction::TransferFrom) action:**
    /// - `INSUFFICIENT_BALANCE`: Thrown if the sender has insufficient token balance (from ERC20
    /// contract).
    /// - `INSUFFICIENT_ALLOWANCE`: Thrown if the sender has insufficient token allowance (from
    /// ERC20 contract).
    ///
    /// #### Access Control
    /// - Any address can call this function.
    ///
    /// #### Notes
    /// - All actions are executed sequentially in the order they appear in the span.
    /// - If any action fails, the entire transaction reverts and no state changes are applied.
    fn execute_actions(ref self: T, actions: Span<ServerAction>);
}

#[starknet::interface]
pub trait IViews<T> {
    /// Checks if a channel exists.
    ///
    /// #### Parameters
    /// - `channel_marker` (`felt252`): The marker of the channel.
    ///
    /// #### Returns
    /// (`bool`): True if the channel exists in the contract, false otherwise.
    fn channel_exists(self: @T, channel_marker: felt252) -> bool;

    /// Returns the number of open channels for the given recipient address.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the
    /// recipient of the channels.
    ///
    /// #### Returns
    /// (`u64`): The number of the open channels for the recipient.
    fn get_num_of_channels(self: @T, recipient_addr: ContractAddress) -> u64;

    /// Returns the encrypted channel information for a given recipient address and channel index.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the
    /// recipient.
    /// - `channel_index` (`u64`): The index of the channel within the recipient's channel vector.
    ///
    /// #### Returns
    /// ([`EncChannelInfo`](privacy::objects::EncChannelInfo)): The encrypted channel information.
    ///
    /// #### Preconditions
    /// - `channel_index` must be a valid index within the `recipient_addr`'s channel vector (i.e.,
    /// `channel_index < get_num_of_channels(recipient_addr)`).
    ///
    /// #### Reverts
    /// - `"Index out of bounds"`: Thrown if `channel_index` is out of bounds (index >= number of
    /// channels for the recipient).
    fn get_channel_info(
        self: @T, recipient_addr: ContractAddress, channel_index: u64,
    ) -> EncChannelInfo;

    /// Checks if a subchannel exists.
    ///
    /// #### Parameters
    /// - `subchannel_marker` (`felt252`): The marker of the subchannel.
    ///
    /// #### Returns
    /// (`bool`): True if the subchannel exists in the contract, false otherwise.
    fn subchannel_exists(self: @T, subchannel_marker: felt252) -> bool;

    /// Returns the encrypted subchannel information for a given subchannel id.
    ///
    /// #### Parameters
    /// - `subchannel_id` (`felt252`): The id of the subchannel.
    ///
    /// #### Returns
    /// ([`EncSubchannelInfo`](privacy::objects::EncSubchannelInfo)): The encrypted subchannel
    /// information, or a zero struct if the subchannel does not exist.
    fn get_subchannel_info(self: @T, subchannel_id: felt252) -> EncSubchannelInfo;

    /// Returns the encrypted outgoing channel information for a given outgoing channel id.
    ///
    /// #### Parameters
    /// - `outgoing_channel_id` (`felt252`): The id of the outgoing channel.
    ///
    /// #### Returns
    /// - ([`EncOutgoingChannelInfo`](privacy::objects::EncOutgoingChannelInfo)): The encrypted
    /// outgoing channel information, or a zero struct if the outgoing channel does not exist.
    fn get_outgoing_channel_info(self: @T, outgoing_channel_id: felt252) -> EncOutgoingChannelInfo;

    /// Returns the note for a given note id.
    ///
    /// #### Parameters
    /// - `note_id` (`felt252`): The id of the note.
    ///
    /// #### Returns
    /// ([`Note`](privacy::objects::Note)): The note, or a zero struct if the note does not exist.
    fn get_note(self: @T, note_id: felt252) -> Note;

    /// Checks if a nullifier exists.
    ///
    /// #### Parameters
    /// - `nullifier` (`felt252`): The nullifier.
    ///
    /// #### Returns
    /// (`bool`): True if the nullifier exists in the contract, false otherwise.
    fn nullifier_exists(self: @T, nullifier: felt252) -> bool;

    /// Returns the registered public viewing key of the given user address.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address whose public key
    /// is being queried.
    ///
    /// #### Returns
    /// - (`felt252`): The public key associated with the user, or zero if not registered.
    fn get_public_key(self: @T, user_addr: ContractAddress) -> felt252;

    /// Returns the encrypted private key of the given user address.
    ///
    /// The private key is encrypted using the compliance public key and can only be decrypted by
    /// the compliance authority.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address whose encrypted
    /// private key is being queried.
    ///
    /// #### Returns
    /// - ([`EncPrivateKey`](privacy::objects::EncPrivateKey)): The encrypted private key associated
    /// with the user, or a zero struct if the user is not registered.
    fn get_enc_private_key(self: @T, user_addr: ContractAddress) -> EncPrivateKey;

    /// Returns the compliance public key used for encrypting private keys.
    ///
    /// This public key is used to encrypt user private keys so that only the compliance authority
    /// can decrypt them. It is also used to encrypt the user_addr when withdrawing.
    ///
    /// #### Parameters
    /// None
    ///
    /// #### Returns
    /// - (`felt252`): The compliance public key.
    fn get_compliance_public_key(self: @T) -> felt252;
}

#[starknet::interface]
pub trait ICompliance<T> {
    fn set_compliance_public_key(ref self: T, compliance_public_key: felt252);
}
