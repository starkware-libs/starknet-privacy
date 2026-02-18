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
    /// Encrypted address of the withdrawing user. Can be decrypted by compliance.
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
pub struct CompliancePublicKeySet {
    /// The compliance public key.
    #[key]
    pub compliance_public_key: felt252,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct OpenNoteCreated {
    /// Encrypted recipient address (the note owner). Can be decrypted by compliance.
    pub enc_recipient_addr: EncUserAddr,
    /// Address allowed to deposit into the note.
    #[key]
    pub depositor: ContractAddress,
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
pub struct NoteUsed {
    /// The nullifier of the used note.
    #[key]
    pub nullifier: felt252,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct FeeSet {
    /// The fee amount in FRI per `apply_actions` call.
    #[key]
    pub fee_amount: u128,
    /// The address that receives the fee.
    #[key]
    pub fee_collector: ContractAddress,
}
