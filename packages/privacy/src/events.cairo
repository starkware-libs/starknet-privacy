use privacy::objects::EncPrivateKey;
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
