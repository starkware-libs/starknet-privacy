# Changelog

## Unreleased

### Breaking

- Privacy pool role-management ABI changed (`PrivacyPoolABI` regenerated). The
  `starkware_utils` upgrade replaced the monolithic `RolesComponent` with
  `CommonRolesComponent`, so the per-role typed selectors
  (`is_app_governor`/`register_app_governor`/`remove_security_governor`/…) are
  removed and replaced by the generic `grant_role(role, account)`,
  `revoke_role(role, account)`, `has_role(role, account)`, and `renounce(role)`
  taking a `Role` enum. Tooling that called the old role selectors must migrate.

### Added

- Screening v2: `ProveTransactionResult.additional_data` (typed, optional)
  parsed from the prove response, carrying an optional `signature`
  (`ScreeningSignature`). Backward-compatible: responses without it parse
  unchanged; unknown fields are still rejected by the strict schema. Exported
  `AdditionalData` / `ScreeningSignature` types.
- Screening v2: `ScreeningRejected` (terminal — sanctioned address) and
  `ScreeningUnavailable` (transient — screener unreachable) error classes, plus
  `screeningErrorFromProvingError()` mapping the interceptor's opaque
  `address_blocked` / `screening_unavailable` reasons (JSON-RPC code 10000).
  Other code-10000 errors return `undefined` so the caller rethrows the
  original rather than mislabeling a transient fault as terminal.
- Screening v2: `apply_actions` calldata carries the screening attestation as a
  trailing Serde-encoded `Option` — `[0x1]` when absent, `[0x0, issued_at,
  sig_r, sig_s]` when the prove response carries a signature (Cairo's `Option`
  Serde tags: `Some` = 0, `None` = 1). `Proof` gains an
  optional `additionalData` relaying the prove response's `additional_data`.
  Emitted **only against a screening-capable pool**, identified with zero RPC
  calls: the prove response's payload is headed by the pool's class hash, which
  the SDK looks up against the pinned class hashes of the deployed
  pre-screening pools on SN_MAIN and SN_SEPOLIA. A pinned
  hash gets today's calldata (no suffix); **any other class hash is treated as
  screening-capable**, so the SDK activates automatically when an upgraded
  pool deploys, and one SDK build is compatible with both pool versions.
- Screening v2: exported `PoolCapabilityMode`, and
  `createPrivateTransfers()` gains an optional `poolMode` override for
  deployments whose pool class hash isn't pinned (e.g. local devnet/test pools
  built from source).
- Screening v2 (testing): `ScreeningCallMockProofProvider` signs each deposit's
  screening attestation with the canonical fixture screener key, and
  `createCompatibilityAliceTransfers()` builds a compatibility-mode transfers
  object. The devnet suite deploys the screening-capable pool, exercises an
  attested deposit (screening mode), and asserts the pool rejects an un-attested
  deposit (compatibility mode).

## 0.14.2-RC.6

### Changed

- `createPrivateTransfers()` `account` parameter type relaxed from `Account` to `{ address, signer }`. A full starknet.js `Account` is structurally assignable, so existing callers compile unchanged. Smart wallets that need account-formatted signatures (e.g. owner + guardian merge) can now pass `{ address: account.address, signer: customProofSigner }` to override the signer used for proof invocations. Closes #718.

### Added

- `PrivateTransfersUser` interface (`{ address, signer }`) exported from `interfaces.ts` for callers who want to type their own minimal account shape.

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
