# 2. Context and Requirements

## 2.1 Storage-based Discovery Model

The privacy pool uses contract storage as the primary data plane:

- Encrypted channels are stored as an array per recipient.
- Subchannels are discovered per channel via an ever-growing index.
- Notes are discovered per subchannel via an ever-growing index.
- Nullifiers are stored in contract state and used to detect spends.

Discovery is driven by iterating indices until a missing entry is observed.

## 2.2 Functional Requirements

**Efficient discovery of incoming notes:**

1. Read recipient channels.
2. Decrypt channels.
3. Discover subchannels and notes via indexed probing.
4. Decrypt notes.
5. Derive nullifiers for decrypted notes and check existence in contract state.
6. Return only unspent notes (those for which the derived nullifier does not exist).

**Efficient restoration of outgoing state:**

- For a channel and token, determine the latest note index without decryption.

**Minimize RPC load:**

- Reduce repeated per-wallet queries.
- Support batching and parallelism where possible.

**Support bounded, resumable synchronization:**

- Avoid long-running requests and timeouts.
- Preserve simple wallet-side logic.

## 2.3 Key Handling Requirement

The service cannot discover channels or notes without access to decryption keys.

- Keys are provided per request.
- Responses contain decrypted data.
