use privacy::hashes::{
    compute_channel_id, compute_channel_key, compute_note_id, compute_nullifier,
    compute_subchannel_id, compute_subchannel_key, hash,
};
use starkware_utils::constants::MAX_U32;

#[test]
fn test_compute_channel_key_different_inputs() {
    let sender_addr = hash(['SENDER_ADDR'].span()).try_into().unwrap();
    let sender_private_key = hash(['SENDER_PRIVATE_KEY'].span());
    let recipient_addr = hash(['RECIPIENT_ADDR'].span()).try_into().unwrap();
    let recipient_public_key = hash(['RECIPIENT_PUBLIC_KEY'].span());
    let channel_key = compute_channel_key(
        :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key,
    );
    let other_sender_addr = hash(['OTHER_SENDER_ADDR'].span()).try_into().unwrap();
    let other_sender_private_key = hash(['OTHER_SENDER_PRIVATE_KEY'].span());
    let other_recipient_addr = hash(['OTHER_RECIPIENT_ADDR'].span()).try_into().unwrap();
    let other_recipient_public_key = hash(['OTHER_RECIPIENT_PUBLIC_KEY'].span());
    assert_ne!(sender_addr, other_sender_addr);
    assert_ne!(sender_private_key, other_sender_private_key);
    assert_ne!(recipient_addr, other_recipient_addr);
    assert_ne!(recipient_public_key, other_recipient_public_key);
    let channel_key_diff_sender_addr = compute_channel_key(
        sender_addr: other_sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key,
    );
    let channel_key_diff_sender_private_key = compute_channel_key(
        :sender_addr,
        sender_private_key: other_sender_private_key,
        :recipient_addr,
        :recipient_public_key,
    );
    let channel_key_diff_recipient_addr = compute_channel_key(
        :sender_addr,
        :sender_private_key,
        recipient_addr: other_recipient_addr,
        :recipient_public_key,
    );
    let channel_key_diff_recipient_public_key = compute_channel_key(
        :sender_addr,
        :sender_private_key,
        :recipient_addr,
        recipient_public_key: other_recipient_public_key,
    );
    assert_ne!(channel_key, channel_key_diff_sender_addr);
    assert_ne!(channel_key, channel_key_diff_sender_private_key);
    assert_ne!(channel_key, channel_key_diff_recipient_addr);
    assert_ne!(channel_key, channel_key_diff_recipient_public_key);
}

#[test]
fn test_compute_channel_id_different_inputs() {
    let channel_key = hash(['CHANNEL_KEY'].span());
    let sender_addr = hash(['SENDER_ADDR'].span()).try_into().unwrap();
    let recipient_addr = hash(['RECIPIENT_ADDR'].span()).try_into().unwrap();
    let recipient_public_key = hash(['RECIPIENT_PUBLIC_KEY'].span());
    let channel_id = compute_channel_id(
        :channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
    );
    let other_channel_key = hash(['OTHER_CHANNEL_KEY'].span());
    let other_sender_addr = hash(['OTHER_SENDER_ADDR'].span()).try_into().unwrap();
    let other_recipient_addr = hash(['OTHER_RECIPIENT_ADDR'].span()).try_into().unwrap();
    let other_recipient_public_key = hash(['OTHER_RECIPIENT_PUBLIC_KEY'].span());
    assert_ne!(channel_key, other_channel_key);
    assert_ne!(sender_addr, other_sender_addr);
    assert_ne!(recipient_addr, other_recipient_addr);
    assert_ne!(recipient_public_key, other_recipient_public_key);
    let channel_id_diff_channel_key = compute_channel_id(
        channel_key: other_channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
    );
    let channel_id_diff_sender_addr = compute_channel_id(
        :channel_key, sender_addr: other_sender_addr, :recipient_addr, :recipient_public_key,
    );
    let channel_id_diff_recipient_addr = compute_channel_id(
        :channel_key, :sender_addr, recipient_addr: other_recipient_addr, :recipient_public_key,
    );
    let channel_id_diff_recipient_public_key = compute_channel_id(
        :channel_key,
        :sender_addr,
        :recipient_addr,
        recipient_public_key: other_recipient_public_key,
    );
    assert_ne!(channel_id, channel_id_diff_channel_key);
    assert_ne!(channel_id, channel_id_diff_sender_addr);
    assert_ne!(channel_id, channel_id_diff_recipient_addr);
    assert_ne!(channel_id, channel_id_diff_recipient_public_key);
}

#[test]
fn test_compute_subchannel_key_different_inputs() {
    let channel_key = hash(['CHANNEL_KEY'].span());
    let index_u256: u256 = hash(['INDEX'].span()).into();
    let index: usize = (index_u256 % MAX_U32.into()).try_into().unwrap();
    let subchannel_key = compute_subchannel_key(:channel_key, :index);
    let other_channel_key = hash(['OTHER_CHANNEL_KEY'].span());
    let other_index_u256: u256 = hash(['OTHER_INDEX'].span()).into();
    let other_index: usize = (other_index_u256 % MAX_U32.into()).try_into().unwrap();
    assert_ne!(channel_key, other_channel_key);
    assert_ne!(index, other_index);
    let subchannel_key_diff_channel_key = compute_subchannel_key(
        channel_key: other_channel_key, index: index,
    );
    let subchannel_key_diff_index = compute_subchannel_key(:channel_key, index: other_index);
    assert_ne!(subchannel_key, subchannel_key_diff_channel_key);
    assert_ne!(subchannel_key, subchannel_key_diff_index);
}

#[test]
fn test_compute_subchannel_id_different_inputs() {
    let channel_key = hash(['CHANNEL_KEY'].span());
    let recipient_addr = hash(['RECIPIENT_ADDR'].span()).try_into().unwrap();
    let recipient_public_key = hash(['RECIPIENT_PUBLIC_KEY'].span());
    let token = hash(['TOKEN'].span()).try_into().unwrap();
    let subchannel_id = compute_subchannel_id(
        :channel_key, :recipient_addr, :recipient_public_key, :token,
    );
    let other_channel_key = hash(['OTHER_CHANNEL_KEY'].span());
    let other_recipient_addr = hash(['OTHER_RECIPIENT_ADDR'].span()).try_into().unwrap();
    let other_recipient_public_key = hash(['OTHER_RECIPIENT_PUBLIC_KEY'].span());
    let other_token = hash(['OTHER_TOKEN'].span()).try_into().unwrap();
    assert_ne!(channel_key, other_channel_key);
    assert_ne!(recipient_addr, other_recipient_addr);
    assert_ne!(recipient_public_key, other_recipient_public_key);
    assert_ne!(token, other_token);
    let subchannel_id_diff_channel_key = compute_subchannel_id(
        channel_key: other_channel_key, :recipient_addr, :recipient_public_key, :token,
    );
    let subchannel_id_diff_recipient_addr = compute_subchannel_id(
        :channel_key, recipient_addr: other_recipient_addr, :recipient_public_key, :token,
    );
    let subchannel_id_diff_recipient_public_key = compute_subchannel_id(
        :channel_key, :recipient_addr, recipient_public_key: other_recipient_public_key, :token,
    );
    let subchannel_id_diff_token = compute_subchannel_id(
        :channel_key, :recipient_addr, :recipient_public_key, token: other_token,
    );
    assert_ne!(subchannel_id, subchannel_id_diff_channel_key);
    assert_ne!(subchannel_id, subchannel_id_diff_recipient_addr);
    assert_ne!(subchannel_id, subchannel_id_diff_recipient_public_key);
    assert_ne!(subchannel_id, subchannel_id_diff_token);
}

#[test]
fn test_compute_note_id_different_inputs() {
    let channel_key = hash(['CHANNEL_KEY'].span());
    let token = hash(['TOKEN'].span()).try_into().unwrap();
    let index_u256: u256 = hash(['INDEX'].span()).into();
    let index: usize = (index_u256 % MAX_U32.into()).try_into().unwrap();
    let note_id = compute_note_id(:channel_key, :token, :index);
    let other_channel_key = hash(['OTHER_CHANNEL_KEY'].span());
    let other_token = hash(['OTHER_TOKEN'].span()).try_into().unwrap();
    let other_index_u256: u256 = hash(['OTHER_INDEX'].span()).into();
    let other_index: usize = (other_index_u256 % MAX_U32.into()).try_into().unwrap();
    assert_ne!(channel_key, other_channel_key);
    assert_ne!(token, other_token);
    assert_ne!(index, other_index);
    let note_id_diff_channel_key = compute_note_id(channel_key: other_channel_key, :token, :index);
    let note_id_diff_token = compute_note_id(:channel_key, token: other_token, :index);
    let note_id_diff_index = compute_note_id(:channel_key, :token, index: other_index);
    assert_ne!(note_id, note_id_diff_channel_key);
    assert_ne!(note_id, note_id_diff_token);
    assert_ne!(note_id, note_id_diff_index);
}

#[test]
fn test_compute_nullifier_different_inputs() {
    let channel_key = hash(['CHANNEL_KEY'].span());
    let token = hash(['TOKEN'].span()).try_into().unwrap();
    let index_u256: u256 = hash(['INDEX'].span()).into();
    let index: usize = (index_u256 % MAX_U32.into()).try_into().unwrap();
    let owner_private_key = hash(['OWNER_PRIVATE_KEY'].span());
    let nullifier = compute_nullifier(:channel_key, :token, :index, :owner_private_key);
    let other_channel_key = hash(['OTHER_CHANNEL_KEY'].span());
    let other_token = hash(['OTHER_TOKEN'].span()).try_into().unwrap();
    let other_index_u256: u256 = hash(['OTHER_INDEX'].span()).into();
    let other_index: usize = (other_index_u256 % MAX_U32.into()).try_into().unwrap();
    let other_owner_private_key = hash(['OTHER_OWNER_PRIVATE_KEY'].span());
    assert_ne!(channel_key, other_channel_key);
    assert_ne!(token, other_token);
    assert_ne!(index, other_index);
    assert_ne!(owner_private_key, other_owner_private_key);
    let nullifier_diff_channel_key = compute_nullifier(
        channel_key: other_channel_key, :token, :index, :owner_private_key,
    );
    let nullifier_diff_token = compute_nullifier(
        :channel_key, token: other_token, :index, :owner_private_key,
    );
    let nullifier_diff_index = compute_nullifier(
        :channel_key, :token, index: other_index, :owner_private_key,
    );
    let nullifier_diff_owner_private_key = compute_nullifier(
        :channel_key, :token, :index, owner_private_key: other_owner_private_key,
    );
    assert_ne!(nullifier, nullifier_diff_channel_key);
    assert_ne!(nullifier, nullifier_diff_token);
    assert_ne!(nullifier, nullifier_diff_index);
    assert_ne!(nullifier, nullifier_diff_owner_private_key);
}
