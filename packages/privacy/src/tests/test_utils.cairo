use privacy::hashes::hash;
use privacy::utils::{TWO_POW_120, decrypt_note_amount, encrypt_note_amount, packing, unpacking};
use starkware_utils::constants::{MAX_U128, TWO_POW_128};

#[test]
fn test_encrypt_decrypt_note_amount() {
    let amounts = [1, 123456789, MAX_U128];
    let mut nonce = 0;
    for amount in amounts.span() {
        nonce += 1;
        let channel_key = hash(['CHANNEL_KEY', nonce.into()].span());
        nonce += 1;
        let random_120_bits_u256: u256 = hash(['RANDOM', nonce.into()].span())
            .into() % TWO_POW_120
            .into();
        let random_120_bits: u128 = random_120_bits_u256.try_into().unwrap();
        let enc_amount = encrypt_note_amount(
            :channel_key, random: random_120_bits, amount: *amount,
        );
        let dec_amount = decrypt_note_amount(enc_note_value: enc_amount, :channel_key);
        assert_eq!(dec_amount, *amount);
    }
}

#[test]
fn test_packing_unpacking() {
    let values: [(u128, felt252); 4] = [
        (1, 1), (1, TWO_POW_128.try_into().unwrap() - 1), (TWO_POW_120.try_into().unwrap() - 1, 1),
        (TWO_POW_120.try_into().unwrap() - 1, TWO_POW_128.try_into().unwrap() - 1),
    ];
    for (value_1, value_2) in values.span() {
        let packed_value = packing(value_1: (*value_1).into(), value_2: *value_2);
        let (unpacked_value_1, unpacked_value_2) = unpacking(:packed_value);
        assert_eq!(unpacked_value_1, *value_1);
        assert_eq!(unpacked_value_2, *value_2);
    }
}

#[test]
fn test_packing_unpacking_random() {
    let mut nonce = 0;
    for _ in 0..100_u32 {
        nonce += 1;
        let value_1_120_bits_u256: u256 = hash(['VALUE_1', nonce.into()].span())
            .into() % TWO_POW_120
            .into();
        let value_1_120_bits: u128 = value_1_120_bits_u256.try_into().unwrap();
        nonce += 1;
        let value_2_128_bits: felt252 = (hash(['VALUE_2', nonce.into()].span())
            .into() % TWO_POW_128)
            .try_into()
            .unwrap();
        let packed_value = packing(value_1: value_1_120_bits, value_2: value_2_128_bits);
        let (unpacked_value_1, unpacked_value_2) = unpacking(:packed_value);
        assert_eq!(unpacked_value_1, value_1_120_bits);
        assert_eq!(unpacked_value_2, value_2_128_bits);
    }
}
