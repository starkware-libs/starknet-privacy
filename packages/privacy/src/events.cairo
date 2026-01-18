use privacy::objects::{EncAddress, EncPrivateKey};
use starknet::ContractAddress;

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct ViewingKeySet {
    /// The user address.
    #[key]
    pub user_addr: ContractAddress,
    /// The public viewing key.
    pub public_key: felt252,
    /// The encrypted private key.
    pub enc_private_key: EncPrivateKey,
}

#[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
pub struct Withdrawal {
    /// Encrypted user_addr who is withdrawing. Can be decrypted by the compliance.
    pub enc_user_addr: EncAddress,
    /// The address to withdraw the funds to.
    #[key]
    pub withdrawal_target: ContractAddress,
    /// The token's address.
    #[key]
    pub token: ContractAddress,
    /// The amount to withdraw.
    pub amount: u128,
}
// TODO: Consider event for deposit.


