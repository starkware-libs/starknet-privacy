# @starkware-libs/starknet-privacy-client

Dapp client for Starknet privacy. A thin, dapp-facing layer over
[`@starkware-libs/starknet-privacy-sdk`](../sdk) that resolves shadow account addresses, bridges
Starknet/EVM wallet signing (SNIP-12 / EIP-712 CallSet signers), and builds privacy operations.

This package is under active development; the public API is being added incrementally. See the
design in `.claude/plans/dapp-sdk-design.md`.

## Installation

The SDK is a peer dependency: dapps pass SDK objects (discovery and proof providers, the note
registry) into the client, so both must share one SDK copy. Install them side by side:

```bash
npm install @starkware-libs/starknet-privacy-client @starkware-libs/starknet-privacy-sdk
```

In this repo, `client` and `sdk` are npm workspaces: run `npm ci` at the repo root and the client
links the local `sdk/`.

## Signers

The `./signers` subpath exports `Snip12CallSetSigner` (legacy Starknet wallets) and
`Eip712CallSetSigner` (EVM wallets / `Eth712Account`) — starknet.js `SignerInterface`
implementations that authorize privacy-pool invocations by signing the `CallSet` message the
pool verifies on-chain, plus the `computeCallSetHash` / `computeCallSet712Hash` golden-vector
oracles. The client factory wires the right one based on the wallet; you can also construct them
directly.

## Scripts

- `npm run build` — type-check and emit to `dist/` (tsc).
- `npm run lint` — prettier + eslint + `tsc --noEmit`.
- `npm run format` — apply prettier + eslint fixes.
- `npm test` — run the vitest suite.
- `npm run check` — build + lint + test.
