# Changelog

## Unreleased

### Breaking

- Switch `starknet` dependency from custom fork (`starkware-libs/starknet.js#PRIVACY-0.14.2-RC.2`) to official `starknet@10.0.0-beta.6`
- `ProofInvocation` type now imports `INVOKE_TXN_V3` from `@starknet-io/starknet-types-0101` (was `@starknet-io/starknet-types-010`)
- Removed `@starknet-io/starknet-types-09` direct dependency (now resolved transitively via starknet)
- **Node.js >= 24** now required (due to `ohttp-ts` dependency using WebCrypto APIs)

### Added

- OHTTP (Oblivious HTTP, RFC 9458) support for `IndexerDiscoveryProvider` — encrypts all discovery requests and responses at the application layer using HPKE, independent of TLS (#TBD)
  - Enable with `new IndexerDiscoveryProvider(url, contract, { ohttp: true })`
  - Optional key pinning via `{ ohttp: { publicKeyConfig: bytes } }` to skip `/ohttp-keys` fetch
  - Optional OHTTP relay support via `{ ohttp: { relayUrl: "..." } }` for client IP hiding
- Export `OhttpClient` class for advanced OHTTP usage outside `IndexerDiscoveryProvider`

### Changed

- Run channel and note discovery concurrently during transaction compilation to reduce latency
- `ProofInvocationFactory` builds `INVOKE_TXN_V3` manually instead of using `RpcChannel.prototype.buildTransaction()` (removed in v10)
- `ProvingService.proveTransaction()` parameter type changed from `INVOKE_TXN_V3` to `ProofInvocation` (same underlying type)
- Remove devnet `getStarknetVersion` monkey-patch and `declareWithoutVersionCheck` workaround (starknet.js#1561 resolved in v10)

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
