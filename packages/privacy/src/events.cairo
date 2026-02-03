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
    /// Encrypted user_addr who is withdrawing. Can be decrypted by the compliance.
    pub enc_user_addr: EncUserAddr,
    /// The address to withdraw the funds to.
    #[key]
    pub withdrawal_target: ContractAddress,
    /// The token's address.
    #[key]
    pub token: ContractAddress,
    /// The amount to withdraw.
    pub amount: u128,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct Deposit {
    /// User address who is depositing.
    #[key]
    pub user_addr: ContractAddress,
    /// The token's address.
    #[key]
    pub token: ContractAddress,
    /// The amount to deposit.
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
    /// Encrypted sender address. Can be decrypted by the compliance.
    pub enc_sender_addr: EncUserAddr,
    /// The address who is allowed to deposit into the note.
    #[key]
    pub depositor: ContractAddress,
    /// The token's address.
    #[key]
    pub token: ContractAddress,
    /// The note ID.
    #[key]
    pub note_id: felt252,
}
