# 9. Storage Slot Calculation and Overhead

## 9.1 Slot Calculation Requirement

Direct storage access requires computing storage keys from known identifiers:

- Channel lists per recipient.
- Subchannels by (channel, token, index) or equivalent.
- Notes by (channel_key, token, index) or equivalent.
- Nullifier locations by derived nullifier.

The exact computation depends on Cairo storage layout and chosen structures (mapping, vector-like patterns, nested layouts).

## 9.2 Practical Overhead

Runtime overhead is low. Slot calculation is dominated by a small number of hash operations per key. The main cost is engineering correctness:

- Implementing slot computation once as a tested library.
- Keeping it aligned with contract layout changes.
- Adding regression tests against known fixtures from deployed contracts.
