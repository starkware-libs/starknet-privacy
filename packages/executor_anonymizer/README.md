# Executor Anonymizer

Maintains a registry of per-commitment [`Executor`](https://github.com/starkware-libs/starkware-starknet-utils)
contracts on behalf of a single privacy contract. Each unique commitment owns a dedicated executor;
later layers run dapp interactions through it and settle the results into the privacy pool's open
notes.

This layer establishes the package scaffold: the storage layout (`privacy_contract`,
`executor_class_hash`, the `executors` registry) and read accessors. The commitment derivation and
interaction entrypoints are built on top.
