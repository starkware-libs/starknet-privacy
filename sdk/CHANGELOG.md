# Changelog

## next

### Breaking

- Rename npm package from `starknet-sdk` to `@starkware-libs/starknet-privacy-sdk`, published to GitHub Packages
- `PrivateRegistry` is now a class (was a type alias). Object literals `{ notes: new AddressMap(...) }` no longer satisfy the type — use `new PrivateRegistry()`.
- `ExecuteResult.applyRegistryUpdate` closure replaced with `ExecuteResult.registryUpdate: RegistryUpdate` data object. Migration: `result.applyRegistryUpdate(registry)` -> `registry.applyExecuteResult(result.registryUpdate)`.
- `ProofInvocationResult.applyRegistryUpdate` — same change as `ExecuteResult`.
- `discoverNotes` return type now includes `cursor: NotesCursor` (in addition to `timestamp` and `notes`).
- `PrivateTransfersBuilder.invoke()` now accepts only a `callBuilder(args) => CallDetails` callback (raw/manual invoke input removed).
- `SimplePrivateTransfersInterface.swap()` now takes executor address directly instead of an object (`swap(fromToken, fromAmount, toToken, executorAddress)`).

### Changed

- `PrivateRegistry` gains `applyDiscoveredNotes()`, `applyDiscoveredChannels()`, and `applyExecuteResult()` methods, encapsulating all registry mutation logic.
- `PoolSimulator.createRegistryUpdate()` returns `RegistryUpdate` data object instead of a closure.
- Cursor/merge logic in compiler.ts and abstract-private-transfers.ts replaced with registry method calls.
- Switch `starknet` dependency from `m-kus/starknet.js` fork to `starkware-industries/starknet.js`
- `invoke` call builder now receives structured context: `{ openNotes, withdrawals, poolAddress }`.

### Fixed

- Align `computeMessageHash` with Cairo after class hash was added to message payload (#573, #571)
- Fix outgoing channel sync skipping first channel in indexer discovery (#555)

### Added

- `RegistryUpdate` type exported from interfaces.ts.
- README rewritten with three comprehensive state management flows (discovery, post-tx update, periodic refresh).
- Invoke action support (#499)

## 0.1.0-dev.1

Initial dev release.
