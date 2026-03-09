# Changelog

## next

### Breaking

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
