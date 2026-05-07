# Changelog

## Unreleased

## 0.14.2-RC.5

### Breaking

- Renamed `MockSwapHelper` to `MockSwapAnonymizer` in `@starkware-libs/starknet-privacy-sdk/testing` (and its `browser` re-export). Update imports accordingly.

### Fixed

- Fixed `INDEX_NOT_SEQUENTIAL` error when the paymaster fee token equals the swap output token (`toToken`) in a private swap. The compiler was emitting `CreateEncNote` at index N+1 before `CreateOpenNote` at index N for the same token. Note-creation actions are now accumulated in a single list in processing order instead of separate enc/open arrays.
- `OhttpClient` now builds the inner OHTTP request URL with a synthetic origin (`https://ohttp-target.invalid`) instead of `${gatewayUrl}${path}`. Previously, when `gatewayUrl` included a reverse-proxy path prefix (e.g. `https://api.example.com/discovery`), that prefix leaked into the encrypted inner request path and produced a 404 inside the OHTTP envelope (`OHTTP inner response /v1/sync/outgoing_state failed (404)`). The OHTTP gateway routes by path only, so the synthetic origin is inert; only the per-call `path` argument is used for routing.

## 0.14.2-RC.3

### Breaking

- Switch `starknet` dependency from custom fork (`starkware-libs/starknet.js#PRIVACY-0.14.2-RC.2`) to official `starknet@10.0.0-beta.6`
- `ProofInvocation` type now imports `INVOKE_TXN_V3` from `@starknet-io/starknet-types-0101` (was `@starknet-io/starknet-types-010`)
- Removed `@starknet-io/starknet-types-09` direct dependency (now resolved transitively via starknet)
- **Node.js >= 24** now required (due to `ohttp-ts` dependency using WebCrypto APIs)
- `fetchHistory` option renamed from `blockRef` to `blockIdentifier` (type: `BlockIdentifier`)
- `HistoryPage.blockRef` changed from `string` to `BlockIdentifier`
- `HistoryCursor.beginBlockNumber` is now optional (`undefined` on first page; server resolves from `block_ref`)

### Added

- OHTTP (Oblivious HTTP, RFC 9458) support for `IndexerDiscoveryProvider` — encrypts all discovery requests and responses at the application layer using HPKE, independent of TLS (#TBD)
  - Enable with `new IndexerDiscoveryProvider(url, contract, { ohttp: true })`
  - Optional key pinning via `{ ohttp: { publicKeyConfig: bytes } }` to skip `/ohttp-keys` fetch
  - Optional OHTTP relay support via `{ ohttp: { relayUrl: "..." } }` for client IP hiding; relay URL is used as-is (target API path is encrypted inside the OHTTP envelope)
  - Warns at construction time when `gatewayUrl` is plain HTTP and no key config is pinned (TOFU key discovery is vulnerable to MITM over unencrypted transport)
- Export `OhttpClient` class for advanced OHTTP usage outside `IndexerDiscoveryProvider`
- OHTTP envelope encryption support for `ProvingServiceProofProvider` — encrypts proving requests and decrypts compressed responses (decrypt-then-decompress)
  - Enable with `new ProvingServiceProofProvider(url, chainId, { ohttp: true })`
  - Same relay/key-pinning options as `IndexerDiscoveryProvider`
  - Also available via `ProofProviderConfig.ohttp` in `createPrivateTransfers()` factory
- Export `OhttpOption` type for reuse in consumer code
- `fee` action type in `classifyTransaction` for withdrawals to fee recipients (e.g. paymaster forwarder), distinct from regular withdrawals
- `ClassifyOptions.feeRecipients` parameter on `classifyTransaction` to identify fee recipient addresses
- `Note.created` is now populated by `IndexerDiscoveryProvider` from the discovery service's per-note `block_number` (slot's `last_update_block`), enabling clients to enforce the 10-block maturity rule before spending

### Changed

- `block_ref` in API models now accepts block hash (hex string), block number (integer), or tag (`"latest"`, `"pre_confirmed"`, `"l1_accepted"`). Wire format is backwards compatible — block hashes remain plain hex strings.
- `discoverNotes` and `discoverChannels` accept optional `blockIdentifier` param to pin discovery reads to a specific block
- Compiler passes `ExecuteOptions.provingBlockId` to discovery as `blockIdentifier`, ensuring discovery and proving use the same block state
- Switch devnet testing from `ProvingServiceProofProvider` to `CallMockProofProvider` with `--proof-mode none` (proofFacts validated, proof ignored)
- Run channel and note discovery concurrently during transaction compilation to reduce latency
- `ProofInvocationFactory` builds `INVOKE_TXN_V3` manually instead of using `RpcChannel.prototype.buildTransaction()` (removed in v10)
- `ProvingService.proveTransaction()` parameter type changed from `INVOKE_TXN_V3` to `ProofInvocation` (same underlying type)
- Remove devnet `getStarknetVersion` monkey-patch and `declareWithoutVersionCheck` workaround (starknet.js#1561 resolved in v10)
- Fee withdrawals no longer prevent `transferSelf` (reorganization) detection
- Fee withdrawals are excluded from incoming transfer actions (receiver doesn't see sender's fee)

### Dependencies

- Added `ohttp-ts` (RFC 9458 implementation by Cloudflare)

## 0.14.2-RC.2

### Added

- History endpoint support via `IndexerDiscoveryProvider.fetchHistory()` for paginated transaction history (#641)
- Classify history events into user-facing actions: deposits, withdrawals, transfers (#637)
- `invalidateProofNonceCache()` on `PrivateTransfersInterface` to clear the cached pool nonce and force a fresh fetch on the next call (#663)
- `nodeUrl` option on `ProofProviderConfig` to enable pool nonce fetching and caching in `ProvingServiceProofProvider` (#663)
- Execution continuation on previously created invocation (#643)

### Changed

- Remove `depositor` from Note storage layout (#661)
- Upgrade Scarb to 2.17.0-rc.4 (Sierra 1.8.0)

## 0.14.2-RC.1

### Breaking

- Rename npm package from `starknet-sdk` to `@starkware-libs/starknet-privacy-sdk`, published to GitHub Packages
- `PrivateTransfersBuilder.invoke()` now accepts only a `callBuilder(args) => CallDetails` callback (raw/manual invoke input removed).
- `SimplePrivateTransfersInterface.swap()` now takes executor address directly instead of an object (`swap(fromToken, fromAmount, toToken, executorAddress)`).

### Changed

- Switch `starknet` dependency from `m-kus/starknet.js` fork to `starkware-industries/starknet.js`
- `invoke` call builder now receives structured context: `{ openNotes, withdrawals, poolAddress }`.

### Fixed

- Align `computeMessageHash` with Cairo after class hash was added to message payload (#573, #571)
- Fix outgoing channel sync skipping first channel in indexer discovery (#555)

### Added

- Invoke action support (#499)

## 0.1.0-dev.1

Initial dev release.
