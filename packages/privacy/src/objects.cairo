use core::dict::{Felt252Dict, Felt252DictTrait, SquashedFelt252DictTrait};
use core::num::traits::Zero;
use starknet::ContractAddress;

// TODO: Optimize.
#[derive(Drop)]
pub(crate) struct TokenBalances {
    balances: Array<(ContractAddress, bool, u128)>,
}

impl DefaultTokenBalances of Default<TokenBalances> {
    fn default() -> TokenBalances {
        TokenBalances { balances: array![] }
    }
}

#[generate_trait]
pub impl TokenBalancesImpl of TokenBalancesTrait {
    fn add_balance(ref self: TokenBalances, token: ContractAddress, balance_change: u128) {
        self.balances.append((token, true, balance_change));
    }

    fn subtract_balance(ref self: TokenBalances, token: ContractAddress, balance_change: u128) {
        self.balances.append((token, false, balance_change));
    }

    fn is_valid(self: @TokenBalances) -> bool {
        let mut final_balances: Felt252Dict<u128> = Default::default();
        for (token, is_addition, balance) in self.balances {
            let token_felt: felt252 = (*token).into();
            if *is_addition {
                final_balances.insert(token_felt, final_balances[token_felt] + *balance);
            } else {
                final_balances.insert(token_felt, final_balances[token_felt] - *balance);
            }
        }
        let balances_entries = final_balances.squash().into_entries();
        for (_, _, last_balance) in balances_entries {
            if last_balance.is_non_zero() {
                return false;
            }
        }
        true
    }
}

/// The path of an existing note in the server storage.
// TODO: Consider renaming.
#[derive(Serde, Copy, Drop)]
pub struct NotePath {
    /// The channel key of the note's channel.
    pub channel_key: felt252,
    /// The note's token address.
    pub token: ContractAddress,
    /// The index of the note within the channel.
    // TODO: Consider changing type to u64.
    pub note_index: usize,
}

/// A note that is created by the owner and sent to a recipient.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct NewNote {
    /// The recipient's address.
    pub recipient_addr: ContractAddress,
    /// The recipient's public key.
    pub recipient_public_key: felt252,
    /// The token's address.
    pub token: ContractAddress,
    /// The amount the note represents.
    // TODO: Consider using different type.
    pub amount: u128,
    /// The index of the note within the channel.
    pub index: usize,
}

// TODO: Move to a different file?
/// Domain-separation tags for contract hashes.
///
/// Template (stable, lowercase):
/// <object_name>:<field_name>:v<major_version>'.
// TODO: Find good template for a single felt.
// TODO: Find better naming convention for tags.
pub mod domain_separation {
    /// Tag for `channel_id`.
    pub const CHANNEL_ID_TAG: felt252 = 'channel_id:v1';
    /// Tag for `channel_key`.
    pub const CHANNEL_KEY_TAG: felt252 = 'channel_key:v1';
    /// Tag for `subchannel_id`.
    pub const SUBCHANNEL_ID_TAG: felt252 = 'subchannel_id:v1';
    /// Tag for `subchannel_key`.
    pub const SUBCHANNEL_KEY_TAG: felt252 = 'subchannel_key:v1';
    /// Tag for `nullifier`.
    pub const NULLIFIER_TAG: felt252 = 'nullifier:v1';
    /// Tags for the `EncChannelInfo` struct.
    // TODO: Now using "channel_info" instead of "enc_channel_info" to fit in a single felt.
    pub mod enc_channel_info {
        pub const ENC_CHANNEL_KEY_TAG: felt252 = 'channel_info:enc_channel_key:v1';
        pub const ENC_SENDER_ADDR_TAG: felt252 = 'channel_info:enc_sender_addr:v1';
    }
    /// Tags for the `EncNote` struct.
    pub mod enc_note {
        pub const NOTE_ID_TAG: felt252 = 'enc_note:id:v1';
        pub const ENC_AMOUNT_TAG: felt252 = 'enc_note:enc_amount:v1';
    }
    /// Tags for the `EncSubchannelInfo` struct.
    // TODO: Now using "subchannel_info" instead of "enc_subchannel_info" to fit in a single felt.
    pub mod enc_subchannel_info {
        pub const ENC_TOKEN_TAG: felt252 = 'subchannel_info:enc_token:v1';
    }
}

/// Ciphertext for an ECDH-based encryption of channel data.
#[derive(Drop, Serde, starknet::Store, PartialEq, Debug, Copy)]
pub struct EncChannelInfo {
    /// Ephemeral ECDH public key x-coordinate (rG.x). Used by the recipient to derive rK.
    pub ephemeral_pubkey: felt252,
    /// Encrypted channel key.
    /// `enc_channel_key = h(CHANNEL_KEY_TAG, rK.x) + channel_key`
    pub enc_channel_key: felt252,
    /// Encrypted sender address.
    /// `enc_sender_addr = h(SENDER_ADDR_TAG, rK.x) + sender_addr`
    pub enc_sender_addr: felt252,
}

// TODO: Move to a different file.
// TODO: Consider implementing is_non_zero() using the Zero trait.
#[generate_trait]
pub impl EncChannelInfoImpl of EncChannelInfoTrait {
    /// Check if all the `EncChannelInfo`'s fields are non-zero.
    fn is_non_zero(self: @EncChannelInfo) -> bool {
        return self.ephemeral_pubkey.is_non_zero()
            && self.enc_channel_key.is_non_zero()
            && self.enc_sender_addr.is_non_zero();
    }
}

/// An encrypted subchannel info, to be written to storage.
// TODO: Explain in doc why the random is needed.
#[derive(Drop, Serde, starknet::Store, PartialEq, Debug, Copy)]
pub struct EncSubchannelInfo {
    /// A random value generated by the sender.
    // TODO: Consider renaming.
    pub random: felt252,
    /// The encrypted token.
    pub enc_token: felt252,
}

// TODO: Move to a different file.
pub impl EncSubchannelInfoZero of Zero<EncSubchannelInfo> {
    fn zero() -> EncSubchannelInfo {
        EncSubchannelInfo { random: Zero::zero(), enc_token: Zero::zero() }
    }
    /// Check if one of the `EncSubchannelInfo`'s fields is zero.
    fn is_zero(self: @EncSubchannelInfo) -> bool {
        return self.random.is_zero() || self.enc_token.is_zero();
    }
    /// Check if all the `EncSubchannelInfo`'s fields are non-zero.
    fn is_non_zero(self: @EncSubchannelInfo) -> bool {
        !self.is_zero()
    }
}

// TODO: Consider refactoring tuples to named structs in ClientAction and ServerAction.
/// An action to be executed by the client.
#[derive(Serde, Copy, Drop, Debug, PartialEq)]
pub enum ClientAction {
    /// Register a new user with a public key.
    /// (user_public_key: felt252)
    Register: felt252,
    /// Replace the user's public key with a new value.
    /// (user_public_key: felt252)
    ReplacePublicKey: felt252,
    /// Open a new channel from the user to a recipient.
    /// (user_private_key: felt252, recipient_addr: ContractAddress, recipient_public_key: felt252,
    /// random: felt252)
    OpenChannel: (felt252, ContractAddress, felt252, felt252),
    /// Open a new subchannel from the user to a recipient.
    /// (recipient_addr: ContractAddress, recipient_public_key: felt252, channel_key: felt252,
    /// index: usize, token: ContractAddress, random: felt252)
    OpenSubchannel: (ContractAddress, felt252, felt252, usize, ContractAddress, felt252),
    /// Creates a new note based on the specified `NewNote`.
    /// (user_private_key: felt252, new_note: NewNote)
    CreateNote: (felt252, NewNote),
}

/// An action to be executed by the server.
#[derive(Serde, Copy, Drop, Debug, PartialEq)]
pub enum ServerAction {
    /// Verify that a storage value is zero/empty and then write to it.
    /// (storage_address: felt252, new_value: felt252)
    WriteIfZero: (felt252, felt252),
    // TODO: Generalize to any type, Merge with WriteIfZero.
    // TODO: Better naming for this action.
    /// Verify that a storage value is zero/empty and then write to it.
    /// (storage_address: felt252, new_value: EncSubchannelInfo)
    WriteIfZeroSubchannel: (felt252, EncSubchannelInfo),
    // TODO: Consider merging with WriteIfZero.
    /// Verify that a storage value is non-zero and then write to it.
    /// (storage_address: felt252, new_value: felt252)
    WriteIfNonZero: (felt252, felt252),
    // TODO: Generalize to any vector.
    /// Append a value to a vector in storage.
    /// (recipient_addr: ContractAddress, recipient_public_key: felt252, enc_channel_info:
    /// EncChannelInfo)
    AppendToVec: (ContractAddress, felt252, EncChannelInfo),
    /// Transfer tokens from a user to the contract (ERC20 transfer_from).
    /// (sender: ContractAddress, token: ContractAddress, amount: u128)
    TransferFrom: (ContractAddress, ContractAddress, u128),
    /// Transfer tokens from the contract to a recipient (ERC20 transfer).
    /// (recipient: ContractAddress, token: ContractAddress, amount: u128)
    TransferTo: (ContractAddress, ContractAddress, u128),
    /// Verify that a storage value is equal to a given value.
    /// (storage_address: felt252, value: felt252)
    VerifyValue: (felt252, felt252),
}
