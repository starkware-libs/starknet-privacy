use privacy::actions::{ClientAction, ServerAction};
use privacy::objects::{
    EncChannelInfo, EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo, Note,
};
use privacy::snip12::ScreeningAttestation;
use starknet::ContractAddress;
use starknet::account::Call;

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
    /// - `calls` (`Array<`[`Call`](starknet::account::Call)`>`): Must contain exactly one call
    /// targeting this contract with selector `compile_actions` and calldata serializing to
    /// `(user_addr, user_private_key, client_actions)`.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - The caller address must be zero.
    /// - The TX version must be 3 or 3 +
    /// [`ESTIMATION_BASE_TX_VERSION`](privacy::utils::constants::ESTIMATION_BASE_TX_VERSION).
    /// - `calls` must contain exactly one call to this contract with selector `compile_actions`.
    /// - The single call's calldata must deserialize to `(user_addr, user_private_key,
    /// client_actions)` where `client_actions` are valid sequential actions on the current state,
    /// see [`compile_actions`](privacy::interface::IClient::compile_actions) for more details.
    /// - The TX signature must be valid for `user_addr`.
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
    /// not 3 (or 3 +
    /// [`ESTIMATION_BASE_TX_VERSION`](privacy::utils::constants::ESTIMATION_BASE_TX_VERSION)).
    /// - [`INVALID_SIGNATURE`](privacy::errors::INVALID_SIGNATURE): Thrown if the TX signature is
    /// invalid (The TX signature should be of `user_addr` who is executing the actions).
    /// - [`EXPECTED_ONE_CALL`](privacy::errors::EXPECTED_ONE_CALL): Thrown if `calls.len() != 1`.
    /// - [`INVALID_CALL_TO`](privacy::errors::INVALID_CALL_TO): Thrown if the call's `to` is not
    /// this contract.
    /// - [`INVALID_CALL_SELECTOR`](privacy::errors::INVALID_CALL_SELECTOR): Thrown if the call's
    /// selector is not `selector!("compile_actions")`.
    /// - [`INVALID_CALLDATA`](privacy::errors::INVALID_CALLDATA): Thrown if the call's calldata
    /// does not deserialize to `(ContractAddress, felt252, Span<ClientAction>)`.
    /// - See [`compile_and_panic`](privacy::interface::IClient::compile_and_panic) for errors that
    /// occur during client action processing.
    ///
    /// #### Access Control
    /// - Only zero caller address.
    ///
    /// #### Notes
    /// - This function parses the single call and internally calls
    /// [`compile_actions`](privacy::interface::IClient::compile_actions) to compile the client
    /// actions into server actions.
    /// - See [`compile_actions`](privacy::interface::IClient::compile_actions) Returns section for
    /// details on which server actions each client action produces.
    /// - This function does not change the state of the contract.
    fn __execute__(ref self: T, calls: Array<Call>);

    /// Processes client actions and panics with the compiled server actions or an error.
    ///
    /// This function processes client actions and always panics with either the
    /// serialized server actions (wrapped with
    /// [`OK_WRAPPER`](privacy::utils::constants::OK_WRAPPER)) or an error. It is called by
    /// [`compile_actions`](privacy::interface::IClient::compile_actions) via syscall to capture the
    /// result.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address of the user executing the actions.
    /// - `user_private_key` (`felt252`): The private key of the user executing the actions.
    /// - `client_actions` (`Span<`[`ClientAction`](privacy::actions::ClientAction)`>`): The list of
    /// client actions to compile. See
    /// [`compile_actions`](privacy::interface::IClient::compile_actions)
    /// for the action list; [`__execute__`](privacy::interface::IClient::__execute__) receives
    /// these inputs via a single call's calldata.
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
    /// - See [`compile_actions`](privacy::interface::IClient::compile_actions) for additional
    /// constraints on `client_actions`.
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
    /// - [`NO_REPLAY_PROTECTION`](privacy::errors::NO_REPLAY_PROTECTION): Thrown if
    /// `client_actions`
    /// does not include any action that provides replay protection (e.g. one that compiles to
    /// WriteOnce).
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
    /// - [`ZERO_RANDOM`](privacy::errors::ZERO_RANDOM): Thrown if the random value is zero.
    /// - [`ZERO_SALT`](privacy::errors::ZERO_SALT): Thrown if the salt is zero.
    /// - [`SENDER_NOT_REGISTERED`](privacy::errors::SENDER_NOT_REGISTERED): Thrown if the sender is
    /// not registered with a viewing key.
    /// - [`SENDER_NOT_AUTHENTICATED`](privacy::errors::SENDER_NOT_AUTHENTICATED): Thrown if the
    /// sender's public key does not match the derived public key from the private key.
    /// - [`RECIPIENT_NOT_REGISTERED`](privacy::errors::RECIPIENT_NOT_REGISTERED): Thrown if the
    /// recipient is not registered with a public key.
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
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`ZERO_SALT`](privacy::errors::ZERO_SALT): Thrown if the salt is zero.
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
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`SUBCHANNEL_NOT_FOUND`](privacy::errors::SUBCHANNEL_NOT_FOUND): Thrown if the subchannel
    /// does not exist.
    /// - [`NOTE_NOT_FOUND`](privacy::errors::NOTE_NOT_FOUND): Thrown if the note does not exist.
    /// - [`ZERO_NOTE_AMOUNT_USAGE`](privacy::errors::ZERO_NOTE_AMOUNT_USAGE): Thrown if the note
    /// has zero amount (e.g. open note not yet deposited to).
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the nullifier already
    /// exists (the note already spent before).
    ///
    /// **Errors for [`CreateEncNote`](privacy::actions::ClientAction::CreateEncNote) action:**
    /// - [`ZERO_RECIPIENT_ADDR`](privacy::errors::ZERO_RECIPIENT_ADDR): Thrown if the recipient
    /// address is zero.
    /// - [`ZERO_RECIPIENT_PUBLIC_KEY`](privacy::errors::ZERO_RECIPIENT_PUBLIC_KEY): Thrown if the
    /// recipient public key is zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`ZERO_SALT`](privacy::errors::ZERO_SALT): Thrown if the salt is zero.
    /// - [`SALT_TOO_SMALL`](privacy::errors::SALT_TOO_SMALL): Thrown if the salt is not greater
    /// than [`OPEN_NOTE_SALT`](privacy::utils::constants::OPEN_NOTE_SALT) (i.e. salt <= 1).
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
    /// **Errors for [`CreateOpenNote`](privacy::actions::ClientAction::CreateOpenNote) action:**
    /// - [`ZERO_RECIPIENT_ADDR`](privacy::errors::ZERO_RECIPIENT_ADDR): Thrown if the recipient
    /// address is zero.
    /// - [`ZERO_RECIPIENT_PUBLIC_KEY`](privacy::errors::ZERO_RECIPIENT_PUBLIC_KEY): Thrown if the
    /// recipient public key is zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`ZERO_RANDOM`](privacy::errors::ZERO_RANDOM): Thrown if the random value is zero.
    /// - [`SUBCHANNEL_NOT_FOUND`](privacy::errors::SUBCHANNEL_NOT_FOUND): Thrown if the subchannel
    /// does not exist.
    /// - [`INDEX_NOT_SEQUENTIAL`](privacy::errors::INDEX_NOT_SEQUENTIAL): Thrown if the note index
    /// is not sequential.
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the note id already exists.
    ///
    /// **Errors for [`Withdraw`](privacy::actions::ClientAction::Withdraw) action:**
    /// - [`ZERO_TO_ADDR`](privacy::errors::ZERO_TO_ADDR): Thrown if the withdrawal target address
    /// is zero.
    /// - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if the token address is zero.
    /// - [`ZERO_AMOUNT`](privacy::errors::ZERO_AMOUNT): Thrown if the withdrawal amount is zero.
    /// - [`ZERO_RANDOM`](privacy::errors::ZERO_RANDOM): Thrown if the random value is zero.
    /// - [`NEGATIVE_INTERMEDIATE_BALANCE`](privacy::errors::NEGATIVE_INTERMEDIATE_BALANCE): Thrown
    /// if token balances become negative during execution.
    ///
    /// **Errors for [`InvokeExternal`](privacy::actions::ClientAction::InvokeExternal) action:**
    /// - [`ZERO_CONTRACT_ADDRESS`](privacy::errors::ZERO_CONTRACT_ADDRESS): Thrown if the target
    /// contract address is zero.
    ///
    /// #### Access Control
    /// - Any address can call this function.
    ///
    /// #### Notes
    /// - This function always panics. On success, it panics with serialized server actions wrapped
    /// with [`OK_WRAPPER`](privacy::utils::constants::OK_WRAPPER). On error, it panics with the
    /// error.
    /// - This function ensures that the contract state cannot be modified by client's functions.
    fn compile_and_panic(
        ref self: T,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    );

    /// Processes client actions and returns the compiled server actions (without sending to L1).
    ///
    /// This function processes a span of [`ClientAction`](privacy::actions::ClientAction) and
    /// compiles each action into corresponding [`ServerAction`](privacy::actions::ServerAction)s.
    /// It internally calls [`compile_and_panic`](privacy::interface::IClient::compile_and_panic)
    /// via syscall to capture the result. Unlike
    /// [`__execute__`](privacy::interface::IClient::__execute__), this function does not send
    /// messages to L1 and does not validate execution context (caller address, TX version, fees).
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address of the user executing the actions.
    /// - `user_private_key` (`felt252`): The private key of the user executing the actions.
    /// - `client_actions` (`Span<`[`ClientAction`](privacy::actions::ClientAction)`>`): The list of
    /// client actions to compile. The logical client actions are:
    ///   Each [`ClientAction`](privacy::actions::ClientAction) variant has the following purpose:
    ///   - [`SetViewingKey`](privacy::actions::ClientAction::SetViewingKey): Register a user with a
    ///   viewing key.
    ///   - [`OpenChannel`](privacy::actions::ClientAction::OpenChannel): Open a new channel from
    ///   the user to a recipient.
    ///   - [`OpenSubchannel`](privacy::actions::ClientAction::OpenSubchannel): Open a new
    ///   subchannel (of specific token) from the user to a recipient.
    ///   - [`CreateEncNote`](privacy::actions::ClientAction::CreateEncNote): Creates a new
    ///   encrypted note with a specified amount.
    ///   - [`CreateOpenNote`](privacy::actions::ClientAction::CreateOpenNote): Creates a new open
    ///   note (zero-value, to be deposited to by a server action).
    ///   - [`Deposit`](privacy::actions::ClientAction::Deposit): Deposit funds into the contract.
    ///   - [`UseNote`](privacy::actions::ClientAction::UseNote): Uses up a note (creates a
    ///   nullifier for it).
    ///   - [`Withdraw`](privacy::actions::ClientAction::Withdraw): Withdraw funds from the
    ///   contract.
    ///   - [`InvokeExternal`](privacy::actions::ClientAction::InvokeExternal): Invokes an external
    ///   contract (forwards as a server-side Invoke action).
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
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the channel existence
    /// flag to storage.
    /// - [`Append`](privacy::actions::ServerAction::Append): Appends the encrypted
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
    /// - [`EmitNoteUsed`](privacy::actions::ServerAction::EmitNoteUsed): Emits a
    /// [`NoteUsed`](privacy::events::NoteUsed) event.
    ///
    /// **For [`CreateEncNote`](privacy::actions::ClientAction::CreateEncNote) action:**
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the encrypted note to
    /// storage.
    /// - [`EmitEncNoteCreated`](privacy::actions::ServerAction::EmitEncNoteCreated): Emits an
    /// [`EncNoteCreated`](privacy::events::EncNoteCreated) event.
    ///
    /// **For [`CreateOpenNote`](privacy::actions::ClientAction::CreateOpenNote) action:**
    /// - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Writes the open note to
    /// storage.
    /// - [`EmitOpenNoteCreated`](privacy::actions::ServerAction::EmitOpenNoteCreated): Emits an
    /// [`OpenNoteCreated`](privacy::events::OpenNoteCreated) event.
    ///
    /// **For [`Withdraw`](privacy::actions::ClientAction::Withdraw) action:**
    /// - [`TransferTo`](privacy::actions::ServerAction::TransferTo): Transfers tokens from the
    /// contract to the withdrawal target via ERC20 `transfer`.
    /// - [`EmitWithdrawal`](privacy::actions::ServerAction::EmitWithdrawal): Emits a
    /// [`Withdrawal`](privacy::events::Withdrawal) event.
    ///
    /// **For [`InvokeExternal`](privacy::actions::ClientAction::InvokeExternal) action:**
    /// - [`Invoke`](privacy::actions::ServerAction::Invoke): Invokes the target contract with the
    /// given calldata.
    ///
    /// #### Preconditions
    /// - `user_addr` must not be zero.
    /// - `user_private_key` must not be zero and must be canonical.
    /// - `client_actions` must be valid sequential actions to execute on the current state of the
    /// contract.
    /// - `client_actions` must be valid sequential actions to execute on the current state of the
    /// contract.
    /// - `client_actions` must be ordered by phase: SetViewingKey, OpenChannel, OpenSubchannel,
    /// Deposit, UseNote, CreateEncNote/CreateOpenNote, Withdraw, InvokeExternal.
    /// - At most one [`InvokeExternal`](privacy::actions::ClientAction::InvokeExternal) action is
    /// allowed per transaction.
    /// - At least one action that provides replay protection must be included
    /// ([`Deposit`](privacy::actions::ClientAction::Deposit),
    /// [`Withdraw`](privacy::actions::ClientAction::Withdraw), and
    /// [`InvokeExternal`](privacy::actions::ClientAction::InvokeExternal) do not provide replay
    /// protection).
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Messages to L1
    /// None
    ///
    /// #### Reverts
    /// See [`compile_and_panic`](privacy::interface::IClient::compile_and_panic) for the complete
    /// list of errors.
    ///
    /// #### Access Control
    /// - Any address can call this function.
    ///
    /// #### Notes
    /// - This function is called by [`__execute__`](privacy::interface::IClient::__execute__) to
    /// compile client actions before sending to L1.
    /// - The function internally calls
    /// [`compile_and_panic`](privacy::interface::IClient::compile_and_panic) via syscall to capture
    /// the result.
    /// - This is a view function which never changes the state.
    fn compile_actions(
        self: @T,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Span<ServerAction>;

    /// Validates execution context and returns valid.
    ///
    /// This function is called by the account (privacy) contract during transaction validation to
    /// check if the transaction can be executed.
    ///
    /// #### Parameters
    /// - `calls` (`Array<`[`Call`](starknet::account::Call)`>`): The calls passed by the account
    /// framework.
    ///
    /// #### Returns
    /// - (`felt252`): Returns [`VALIDATED`](starknet::VALIDATED) when execution info is valid.
    ///
    /// #### Preconditions
    /// - The effective fee of the transaction is zero (i.e. `tip` and `resource_bounds`).
    /// - The TX version is 3 or 3 +
    /// [`ESTIMATION_BASE_TX_VERSION`](privacy::utils::constants::ESTIMATION_BASE_TX_VERSION).
    ///
    /// #### Reverts
    /// - [`INVALID_TX_VERSION`](privacy::errors::INVALID_TX_VERSION): Thrown if the TX version is
    /// not 3 (or 3 +
    /// [`ESTIMATION_BASE_TX_VERSION`](privacy::utils::constants::ESTIMATION_BASE_TX_VERSION)).
    /// - [`NON_ZERO_TIP`](privacy::errors::NON_ZERO_TIP): Thrown if the transaction tip is not
    /// zero.
    /// - [`NON_ZERO_RESOURCE_PRICE`](privacy::errors::NON_ZERO_RESOURCE_PRICE): Thrown if the
    /// transaction resource prices are not zero.
    ///
    /// #### Notes
    /// - This function is part of the account contract interface and is called automatically during
    /// transaction validation.
    fn __validate__(self: @T, calls: Array<Call>) -> felt252;
}

#[starknet::interface]
pub trait IServer<T> {
    /// Applies a list of server actions atomically.
    ///
    /// This function applies a span of [`ServerAction`](privacy::actions::ServerAction)s in
    /// sequence, performing storage operations, token transfers, and event emissions. All actions
    /// are applied atomically - if any action fails, the entire transaction reverts. The contract
    /// must not be paused for this function to execute.
    ///
    /// #### Parameters
    /// - `actions` (`Span<`[`ServerAction`](privacy::actions::ServerAction)`>`): The list of server
    /// actions to apply.
    ///   Each [`ServerAction`](privacy::actions::ServerAction) variant has the following purpose:
    ///   - [`WriteOnce`](privacy::actions::ServerAction::WriteOnce): Verify that a storage value is
    ///   zero/empty and then write to it.
    ///   - [`Append`](privacy::actions::ServerAction::Append): Append an encrypted
    ///   channel info value to a recipient's channel vector in storage.
    ///   - [`TransferFrom`](privacy::actions::ServerAction::TransferFrom): Transfer tokens from a
    ///   user to the contract via ERC20 `transfer_from`.
    ///   - [`TransferTo`](privacy::actions::ServerAction::TransferTo): Transfer tokens from the
    ///   contract to a recipient via ERC20 `transfer`.
    ///   - [`EmitViewingKeySet`](privacy::actions::ServerAction::EmitViewingKeySet): Emit a
    ///   [`ViewingKeySet`](privacy::events::ViewingKeySet) event.
    ///   - [`EmitWithdrawal`](privacy::actions::ServerAction::EmitWithdrawal): Emit a
    ///   [`Withdrawal`](privacy::events::Withdrawal) event.
    ///   - [`EmitDeposit`](privacy::actions::ServerAction::EmitDeposit): Emit a
    ///   [`Deposit`](privacy::events::Deposit) event.
    ///   - [`EmitOpenNoteCreated`](privacy::actions::ServerAction::EmitOpenNoteCreated): Emit an
    ///   [`OpenNoteCreated`](privacy::events::OpenNoteCreated) event.
    ///   - [`EmitEncNoteCreated`](privacy::actions::ServerAction::EmitEncNoteCreated): Emit an
    ///   [`EncNoteCreated`](privacy::events::EncNoteCreated) event.
    ///   - [`EmitNoteUsed`](privacy::actions::ServerAction::EmitNoteUsed): Emit a
    ///   [`NoteUsed`](privacy::events::NoteUsed) event.
    ///   - [`Invoke`](privacy::actions::ServerAction::Invoke): Invoke an external contract.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - The contract must not be paused.
    /// - The caller must have sufficient STRK balance and allowance to pay the fee (see
    /// [`get_fee_amount`](privacy::interface::IFees::get_fee_amount)).
    /// - `proof_facts` in the TX info must be valid for the given `actions` (see Reverts).
    /// - For [`WriteOnce`](privacy::actions::ServerAction::WriteOnce) actions, the storage location
    /// must be empty (zero) before writing.
    /// - For [`TransferFrom`](privacy::actions::ServerAction::TransferFrom) actions, the sender
    /// must have sufficient token balance and allowance.
    /// - For [`Invoke`](privacy::actions::ServerAction::Invoke) actions, the invoked contract must
    /// have an [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR) selector for a
    /// method that returns a `Span<`[`OpenNoteDeposit`](privacy::objects::OpenNoteDeposit)`>`.
    ///
    /// #### Events Emitted
    /// Events are emitted based on the server actions in the input:
    /// - [`ViewingKeySet`](privacy::events::ViewingKeySet): Emitted when
    /// [`EmitViewingKeySet`](privacy::actions::ServerAction::EmitViewingKeySet) action is executed.
    /// - [`Withdrawal`](privacy::events::Withdrawal): Emitted when
    /// [`EmitWithdrawal`](privacy::actions::ServerAction::EmitWithdrawal) action is executed.
    /// - [`Deposit`](privacy::events::Deposit): Emitted when
    /// [`EmitDeposit`](privacy::actions::ServerAction::EmitDeposit) action is executed.
    /// - [`OpenNoteCreated`](privacy::events::OpenNoteCreated): Emitted when
    /// [`EmitOpenNoteCreated`](privacy::actions::ServerAction::EmitOpenNoteCreated) action is
    /// executed.
    /// - [`EncNoteCreated`](privacy::events::EncNoteCreated): Emitted when
    /// [`EmitEncNoteCreated`](privacy::actions::ServerAction::EmitEncNoteCreated) action is
    /// executed.
    /// - [`NoteUsed`](privacy::events::NoteUsed): Emitted when
    /// [`EmitNoteUsed`](privacy::actions::ServerAction::EmitNoteUsed) action is executed.
    /// - [`OpenNoteDeposited`](privacy::events::OpenNoteDeposited): Emitted for each
    /// `OpenNoteDeposit` returned by an [`Invoke`](privacy::actions::ServerAction::Invoke) action.
    ///
    /// #### Reverts
    /// **Context validation (before applying actions):**
    /// - Thrown if the contract is paused (from Pausable component).
    /// - ReentrancyGuard reentrant call: Thrown if this call is reentrant (e.g. an Invoke
    ///   action called a contract that attempted to call `apply_actions` again). Reentrant
    ///   `apply_actions` is not allowed (from OpenZeppelin ReentrancyGuard component).
    /// - [`PROOF_FACTS_DESERIALIZE_ERROR`](privacy::errors::PROOF_FACTS_DESERIALIZE_ERROR): Thrown
    /// if `proof_facts` in the TX info cannot be deserialized.
    /// - [`INVALID_PROGRAM_VARIANT`](privacy::errors::INVALID_PROGRAM_VARIANT): Thrown if the proof
    /// program variant is invalid.
    /// - [`INVALID_OS_OUTPUT_VERSION`](privacy::errors::INVALID_OS_OUTPUT_VERSION): Thrown if the
    /// proof OS output version is invalid.
    /// - [`INVALID_BASE_BLOCK_NUMBER`](privacy::errors::INVALID_BASE_BLOCK_NUMBER): Thrown if the
    /// proof block number is in the future.
    /// - [`PROOF_EXPIRED`](privacy::errors::PROOF_EXPIRED): Thrown if the proof is too old.
    /// - [`INVALID_PROOF_MSG`](privacy::errors::INVALID_PROOF_MSG): Thrown if the proof message
    /// hash does not match the computed hash of the actions.
    /// - Fee collection (STRK transfer from caller to fee collector) may revert with ERC20 errors
    /// (e.g. insufficient balance or allowance) when fee is non-zero.
    ///
    /// **Errors for [`WriteOnce`](privacy::actions::ServerAction::WriteOnce) action:**
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if the value at the specified
    /// storage path already exists (is not zero).
    ///
    /// **Errors for [`TransferFrom`](privacy::actions::ServerAction::TransferFrom) action:**
    /// - `INSUFFICIENT_BALANCE`: Thrown if the sender has insufficient token balance (from ERC20
    /// contract).
    /// - `INSUFFICIENT_ALLOWANCE`: Thrown if the sender has insufficient token allowance (from
    /// ERC20 contract).
    ///
    /// **Errors for [`Invoke`](privacy::actions::ServerAction::Invoke) action:**
    /// - The invoked contract may revert with any error.
    /// - [`INVALID_INVOKE_RETURN_DATA`](privacy::errors::INVALID_INVOKE_RETURN_DATA): Thrown if
    /// the return data from the invoked contract is invalid.
    /// - When processing the returned
    /// [`OpenNoteDeposit`](privacy::objects::OpenNoteDeposit) values:
    ///   - [`ZERO_TOKEN`](privacy::errors::ZERO_TOKEN): Thrown if `token` is zero.
    ///   - [`ZERO_AMOUNT`](privacy::errors::ZERO_AMOUNT): Thrown if `amount` is zero.
    ///   - [`NOTE_NOT_FOUND`](privacy::errors::NOTE_NOT_FOUND): Thrown if the note does not exist.
    ///   - [`NOTE_NOT_OPEN`](privacy::errors::NOTE_NOT_OPEN): Thrown if the note is not an open
    ///   note.
    ///   - [`NOTE_ALREADY_DEPOSITED`](privacy::errors::NOTE_ALREADY_DEPOSITED): Thrown if the note
    ///   has already been deposited to.
    ///   - [`TOKEN_MISMATCH`](privacy::errors::TOKEN_MISMATCH): Thrown if `token` does not match
    ///   the note's token.
    ///   - `INSUFFICIENT_BALANCE`: Thrown if the depositor has insufficient token balance (from
    ///   ERC20 contract).
    ///   - `INSUFFICIENT_ALLOWANCE`: Thrown if the depositor has insufficient token allowance (from
    ///   ERC20 contract).
    ///
    /// #### Access Control
    /// - Any address can call this function.
    ///
    /// #### Notes
    /// - A fee (in STRK) is collected from the caller before applying actions when
    /// [`get_fee_amount`](privacy::interface::IFees::get_fee_amount) is non-zero.
    /// - All actions are applied sequentially in the order they appear in the span.
    /// - If any action fails, the entire transaction reverts and no state changes are applied.
    /// - Reentrant calls to `apply_actions` (e.g. from a contract invoked via an Invoke action)
    ///   are rejected by the ReentrancyGuard component.
    ///
    /// #### Screening
    /// Every regular-pool deposit (`TransferFrom`) must be authorized by a recent off-chain
    /// screening attestation. `screening` carries the screener's signature over the deposit's
    /// depositor (`TransferFrom.from_addr`, taken from the proven actions — not the caller) and
    /// an `issued_at` timestamp. It must be:
    /// - [`Option::Some`] when the tx contains a deposit, else
    /// [`SCREENING_REQUIRED`](privacy::errors::SCREENING_REQUIRED).
    /// - [`Option::None`] when the tx contains no deposit (transfers/withdrawals); a `Some` with no
    /// deposit reverts with
    /// [`UNEXPECTED_SCREENING`](privacy::errors::UNEXPECTED_SCREENING).
    ///
    /// All `TransferFrom` actions in one tx must share a single `from_addr`
    /// ([`MULTIPLE_DEPOSITORS`](privacy::errors::MULTIPLE_DEPOSITORS) otherwise). Screening
    /// reverts:
    /// - [`SCREENING_FUTURE_DATED`](privacy::errors::SCREENING_FUTURE_DATED): `issued_at` is in the
    /// future.
    /// - [`SCREENING_EXPIRED`](privacy::errors::SCREENING_EXPIRED): the attestation is older than
    /// the max age.
    /// - [`SCREENING_INVALID_SIGNATURE`](privacy::errors::SCREENING_INVALID_SIGNATURE): the
    /// signature does not verify against the configured screener public key for this depositor.
    ///
    /// #### Parameters
    /// - `screening` (`Option<`[`ScreeningAttestation`](privacy::snip12::ScreeningAttestation)`>`):
    /// the deposit's screening attestation, or `None` for non-deposit txs.
    fn apply_actions(
        ref self: T, actions: Span<ServerAction>, screening: Option<ScreeningAttestation>,
    );
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
    /// The [`Note`](privacy::objects::Note) struct contains `packed_value` (salt and amount) and
    /// `token` (zero for encrypted notes).
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
    /// The private key is encrypted using the auditor public key and can only be decrypted
    /// by the auditor.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address whose encrypted
    /// private key is being queried.
    ///
    /// #### Returns
    /// - ([`EncPrivateKey`](privacy::objects::EncPrivateKey)): The encrypted private key associated
    /// with the user, or a zero struct if the user is not registered.
    fn get_enc_private_key(self: @T, user_addr: ContractAddress) -> EncPrivateKey;

    /// Returns the auditor public key used for encrypting private keys.
    ///
    /// This public key is used to encrypt user private keys so that only the auditor
    /// can decrypt them. It is also used to encrypt the user_addr when withdrawing.
    ///
    /// #### Parameters
    /// None
    ///
    /// #### Returns
    /// - (`felt252`): The auditor public key.
    fn get_auditor_public_key(self: @T) -> felt252;

    /// Returns the screener public key used to verify depositor screening attestations.
    ///
    /// #### Parameters
    /// None
    ///
    /// #### Returns
    /// - (`felt252`): The screener public key.
    fn get_screener_public_key(self: @T) -> felt252;

    /// Returns the contract version.
    ///
    /// #### Parameters
    /// None
    ///
    /// #### Returns
    /// - (`felt252`): The contract version as a short-string felt (e.g. `'2.0'`).
    fn get_version(self: @T) -> felt252;

    /// Returns the fee amount charged per `apply_actions` call.
    ///
    /// #### Parameters
    /// None
    ///
    /// #### Returns
    /// - (`u128`): The fee amount in FRI. Zero when fees are disabled.
    fn get_fee_amount(self: @T) -> u128;

    /// Returns the fee collector address.
    ///
    /// #### Parameters
    /// None
    ///
    /// #### Returns
    /// - (`ContractAddress`): The fee collector address.
    fn get_fee_collector(self: @T) -> ContractAddress;

    /// Returns the number of blocks that a proof is valid for.
    ///
    /// #### Parameters
    /// None
    ///
    /// #### Returns
    /// - (`u64`): The number of blocks that a proof is valid for.
    fn get_proof_validity_blocks(self: @T) -> u64;

    /// Returns whether a depositor is blocked from funding open-note deposits.
    ///
    /// #### Parameters
    /// - `depositor` (`ContractAddress`): The depositor address to query.
    ///
    /// #### Returns
    /// - (`bool`): `true` if the depositor is blocked, `false` otherwise.
    fn is_depositor_blocked(self: @T, depositor: ContractAddress) -> bool;
}

#[starknet::interface]
pub trait IAdmin<T> {
    /// Sets the auditor public key used for encrypting user private keys and withdrawal addresses.
    ///
    /// This key is used to encrypt user private keys (so only the auditor can decrypt them) and to
    /// encrypt the user address when withdrawing. Only the token admin can call this function.
    ///
    /// #### Parameters
    /// - `auditor_public_key` (`felt252`): The new auditor public key. Must be non-zero.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Events Emitted
    /// - [`AuditorPublicKeySet`](privacy::events::AuditorPublicKeySet): Emitted with the new
    /// auditor public key.
    ///
    /// #### Reverts
    /// - [`ZERO_AUDITOR_PUBLIC_KEY`](privacy::errors::ZERO_AUDITOR_PUBLIC_KEY): Thrown if
    /// `auditor_public_key` is zero.
    ///
    /// #### Access Control
    /// - Only token admin.
    ///
    /// #### Notes
    /// - Rotating the auditor key creates a persistent audit gap:
    /// `enc_private_key` is encrypted to the auditor key active at registration, so a new auditor
    /// cannot derive channel keys for pre-rotation users and cannot decrypt their activity —
    /// even activity occurring after the rotation. Full continuity requires out-of-band
    /// coordination (e.g., the retiring auditor re-encrypting historical viewing keys to the
    /// new auditor before rotation).
    fn set_auditor_public_key(ref self: T, auditor_public_key: felt252);

    /// Sets the screener public key used to verify depositor screening attestations for
    /// regular-pool deposits.
    ///
    /// Mandatory screening means a rotation to a key the screener no longer holds halts all
    /// regular deposits until corrected, so rotations must be coordinated out-of-band with the
    /// screening service.
    ///
    /// #### Parameters
    /// - `screener_public_key` (`felt252`): The new screener public key. Must be non-zero and a
    /// valid Stark-curve x-coordinate.
    ///
    /// #### Events Emitted
    /// - [`ScreenerPublicKeySet`](privacy::events::ScreenerPublicKeySet): Emitted with the new
    /// screener public key.
    ///
    /// #### Reverts
    /// - [`INVALID_PUBLIC_KEY`](privacy::errors::INVALID_PUBLIC_KEY): Thrown if
    /// `screener_public_key` is zero.
    /// - [`INVALID_PUBLIC_KEY`](privacy::errors::INVALID_PUBLIC_KEY): Thrown if
    /// `screener_public_key` is not a valid Stark-curve x-coordinate.
    ///
    /// #### Access Control
    /// - Only security governor.
    fn set_screener_public_key(ref self: T, screener_public_key: felt252);

    /// Sets the fee amount in FRI per `apply_actions` call.
    ///
    /// #### Parameters
    /// - `fee_amount` (`u128`): The fee amount. Set to 0 to disable fees.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - The fee collector must be non-zero when `fee_amount` is non-zero.
    ///
    /// #### Events Emitted
    /// - [`FeeAmountSet`](privacy::events::FeeAmountSet): Emitted with the new fee amount.
    ///
    /// #### Reverts
    /// - [`ZERO_FEE_COLLECTOR`](privacy::errors::ZERO_FEE_COLLECTOR): Thrown if `fee_amount` is
    /// non-zero and the fee collector is zero (set the collector first).
    ///
    /// #### Access Control
    /// - Only app governor.
    fn set_fee_amount(ref self: T, fee_amount: u128);

    /// Sets the address that receives the fee from `apply_actions` calls.
    ///
    /// #### Parameters
    /// - `fee_collector` (`ContractAddress`): The address to which fees are sent.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - If setting the collector to zero, the fee amount must already be zero.
    ///
    /// #### Events Emitted
    /// - [`FeeCollectorSet`](privacy::events::FeeCollectorSet): Emitted with the new fee
    /// collector.
    ///
    /// #### Reverts
    /// - [`ZERO_FEE_COLLECTOR`](privacy::errors::ZERO_FEE_COLLECTOR): Thrown if the fee amount is
    /// non-zero and `fee_collector` is zero.
    ///
    /// #### Access Control
    /// - Only app governor.
    fn set_fee_collector(ref self: T, fee_collector: ContractAddress);

    /// Sets the number of blocks that a proof is valid for.
    ///
    /// #### Parameters
    /// - `proof_validity_blocks` (`u64`): The number of blocks that a proof is valid for.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - The number of blocks must be greater than 0.
    ///
    /// #### Events Emitted
    /// - [`ProofValidityBlockIntervalSet`](privacy::events::ProofValidityBlockIntervalSet): Emitted
    /// with the new proof validity block interval.
    ///
    /// #### Reverts
    /// - [`ZERO_PROOF_VALIDITY_BLOCKS`](privacy::errors::ZERO_PROOF_VALIDITY_BLOCKS):
    /// Thrown if `proof_validity_blocks` is zero.
    ///
    /// #### Access Control
    /// - Only app governor.
    fn set_proof_validity_blocks(ref self: T, proof_validity_blocks: u64);

    /// Add/Remove addresses to/from the block list of depositors to open-note.
    ///
    /// A blocked depositor cannot fund any open note: every `_deposit_to_open_note`
    /// originating from that depositor reverts with
    /// [`DEPOSITOR_BLOCKED`](privacy::errors::DEPOSITOR_BLOCKED).
    ///
    /// #### Parameters
    /// - `depositor` (`ContractAddress`): The depositor address to block or unblock. Must be
    /// non-zero.
    /// - `blocked` (`bool`): `true` to block the depositor, `false` to unblock.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Events Emitted
    /// - [`DepositorBlockSet`](privacy::events::DepositorBlockSet): Emitted with the depositor and
    /// the new block state.
    ///
    /// #### Reverts
    /// - [`ZERO_CONTRACT_ADDRESS`](privacy::errors::ZERO_CONTRACT_ADDRESS): Thrown if `depositor`
    /// is zero.
    ///
    /// #### Access Control
    /// - Only security governor.
    fn set_depositor_blocked(ref self: T, depositor: ContractAddress, blocked: bool);
}
