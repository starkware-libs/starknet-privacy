# 1. Summary

A dedicated discovery service is required to make note and channel synchronization practical for wallets. The privacy pool stores encrypted channels and notes as well as boolean sets for channels/subchannels and nullifiers in contract storage, and discovery requires many existence probes across indexed lists. The proposed solution is a hybrid model:

- A hot, indexed cache built from on-chain state updates (storage diffs) for fast reads.
- A local or remote RPC fallback path for edge cases.

The service decrypts and returns decrypted channels and unspent notes. Decryption keys must be provided per request. Persistent key storage is explicitly not part of the default design.
