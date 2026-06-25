use privacy::objects::{EncPrivateKey, EncUserAddr};
use starknet::ContractAddress;

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct ViewingKeySet {
    /// The user address.
    #[key]
    pub user_addr: ContractAddress,
    /// The public viewing key.
    #[key]
    pub public_key: felt252,
    /// The encrypted private key.
    pub enc_private_key: EncPrivateKey,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct Withdrawal {
    /// Encrypted address of the withdrawing user. Can be decrypted by the auditor.
    pub enc_user_addr: EncUserAddr,
    /// The address the funds are withdrawn to.
    #[key]
    pub to_addr: ContractAddress,
    /// The token address.
    #[key]
    pub token: ContractAddress,
    /// The withdrawn amount.
    pub amount: u128,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct Deposit {
    /// The depositing user address.
    #[key]
    pub user_addr: ContractAddress,
    /// The token address.
    #[key]
    pub token: ContractAddress,
    /// The deposited amount.
    pub amount: u128,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct AuditorPublicKeySet {
    /// The auditor public key.
    pub auditor_public_key: felt252,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct ScreenerPublicKeySet {
    /// The screener public key is used to verify depositor screening attestations.
    pub screener_public_key: felt252,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct OpenNoteCreated {
    /// Encrypted recipient address (the note owner). Can be decrypted by the auditor.
    pub enc_recipient_addr: EncUserAddr,
    /// The token address.
    #[key]
    pub token: ContractAddress,
    /// The note ID.
    #[key]
    pub note_id: felt252,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct OpenNoteDeposited {
    /// The address that performed the deposit.
    #[key]
    pub depositor: ContractAddress,
    /// The token address.
    #[key]
    pub token: ContractAddress,
    /// The note ID deposited into.
    #[key]
    pub note_id: felt252,
    /// The deposited amount.
    pub amount: u128,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct ExternalInvoke {
    /// The external contract the pool invoked.
    #[key]
    pub contract_address: ContractAddress,
    /// The entry point selector the pool called: `privacy_invoke` for a plain invoke,
    /// `privacy_invoke_with_computation` for a compute-and-invoke. Lets consumers tell the
    /// two apart (the private computation itself is not observable). Calldata is not emitted.
    #[key]
    pub selector: felt252,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct EncNoteCreated {
    /// The note ID.
    #[key]
    pub note_id: felt252,
    /// The packed note value (encodes salt and amount).
    pub packed_value: felt252,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct NoteUsed {
    /// The nullifier of the used note.
    #[key]
    pub nullifier: felt252,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct FeeAmountSet {
    /// The fee amount in FRI per `apply_actions` call.
    pub fee_amount: u128,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct FeeCollectorSet {
    /// The address that receives the fee.
    pub fee_collector: ContractAddress,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct ProofValidityBlocksSet {
    /// The number of blocks that a proof is valid for.
    pub proof_validity_blocks: u64,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct OpenNoteDepositorBlockSet {
    /// The open-note depositor address whose block state changed.
    #[key]
    pub depositor: ContractAddress,
    /// Whether the depositor is now blocked.
    pub blocked: bool,
}
