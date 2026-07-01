# Starknet Privacy

Privacy pool protocol for Starknet.

[![License: Apache2.0](https://img.shields.io/badge/License-Apache2.0-green.svg)](LICENSE)

Users submit private transfers through the SDK, which compiles client actions and sends them to an operator-side proving service. The proving service executes these actions in virtual Starknet blocks and returns a validity proof together with proof facts back to the SDK. The SDK builds a transaction that the wallet submits (ideally via a paymaster to avoid leaking sender info) to Starknet. Starknet verifies the proof and provides validated proof facts to the pool contract via syscall. A discovery service indexes encrypted on-chain storage so wallets can efficiently sync their notes without scanning the full chain.

## Architecture

```mermaid
graph LR
    subgraph Offchain
        Wallet([Wallet])
        SDK[SDK]
        Discovery[Discovery]
        Proving[Proving]
    end

    subgraph Onchain
        Contract[Privacy Pool]
        Anonymizers[Invoke Anonymizers]
    end

    Wallet --> SDK
    SDK --> Discovery
    SDK --> Proving
    SDK --> Contract
    Discovery --> Contract
    Proving --> Contract
    Contract --> Anonymizers
```

- **SDK** — Orchestrates private transfers (register, transfer, discover)
- **Discovery Service** — Indexes encrypted on-chain storage for efficient wallet sync
- **Proving Service** — Executes actions in virtual Starknet blocks and returns validity proofs + proof facts to the SDK
- **Privacy Pool Contract** — Source of truth for actions, storage layout, cryptography
- **Invoke Anonymizers** — External contracts callable from within a private transaction (e.g. swap executors)

## Compatibility matrix

All components in a row are tested together. Use matching revisions when deploying.

| Component          | Docs                                                                                                                     | Tag                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transaction Prover | [README](https://github.com/starkware-libs/sequencer/tree/avi/privacy/configmap-docs/crates/starknet_transaction_prover) | [`ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2`](https://github.com/starkware-libs/sequencer/pkgs/container/starknet-privacy%2Ftransaction-prover?tag=PRIVACY-0.14.3-RC.2) |
| Proof Interceptor† | [README](proof-interceptor/README.md)                                                                                    | [`ghcr.io/starkware-libs/starknet-privacy/proof-interceptor:PRIVACY-0.14.3-RC.2`](https://github.com/starkware-libs/starknet-privacy/pkgs/container/starknet-privacy%2Fproof-interceptor)                    |
| Discovery Service  | [README](deploy/discovery-service/README.md)                                                                             | [`ghcr.io/starkware-libs/starknet-privacy/discovery-service:PRIVACY-0.14.3-RC.2`](https://github.com/starkware-libs/starknet-privacy/pkgs/container/starknet-privacy%2Fdiscovery-service)                    |
| Pathfinder\*       | [docs](https://eqlabs.github.io/pathfinder/getting-started/running-pathfinder)                                           | [`eqlabs/pathfinder:v0.22.7`](https://hub.docker.com/layers/eqlabs/pathfinder/v0.22.7/images/sha256-443ba8749c501f0dc5d8c8fbf03805ab7f3e9fc8ca8948f2e680005599a7f6a0)                                        |
| SDK                | [README](sdk/README.md)                                                                                                  | [`PRIVACY-0.14.3-RC.2`](https://github.com/starkware-libs/starknet-privacy/tree/PRIVACY-0.14.3-RC.2)                                                                                                         |

\* For the transaction prover to work correctly with Pathfinder, set `PATHFINDER_STORAGE_STATE_TRIES=10000`.

† Optional deposit-screening sidecar to the transaction prover; deploy only for screening-enabled pools.

### Contracts

| Contract         | Docs                                                                                                    | Tag                                                                                                  | Class Hash                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Privacy Pool     | [README](packages/privacy/README.md)                                                                    | [`PRIVACY-0.14.3-RC.0`](https://github.com/starkware-libs/starknet-privacy/tree/PRIVACY-0.14.3-RC.0) | `0x52107fadffab71bdcbb6b2ccb68ba3e1b5558d94036538053e159d3076ad633` |
| Ekubo Anonymizer | [README](packages/ekubo_swap_anonymizer/README.md)                                                      | [`PRIVACY-0.14.3-RC.0`](https://github.com/starkware-libs/starknet-privacy/tree/PRIVACY-0.14.3-RC.0) | `0x2a4ac595283d4d64b9952f5ef5c0da1775bfdb7c9d92237524a21dd8d19ebd7` |
| Vesu Anonymizer  | [README](https://github.com/starkware-libs/starknet-privacy/tree/main/packages/vesu_lending_anonymizer) | [`PRIVACY-0.14.3-RC.0`](https://github.com/starkware-libs/starknet-privacy/tree/PRIVACY-0.14.3-RC.0) | `0x3751128dc3ebd36215f982766f14aaca8f78793e4b0f42a73e49372a8e24aae` |

## Repository map

| Directory                                                            | Description                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`packages/privacy/`](packages/privacy/)                             | Cairo smart contract ([README](packages/privacy/README.md))                           |
| [`crates/discovery-core/`](crates/discovery-core/)                   | Core discovery logic & cryptography ([README](crates/discovery-core/README.md))       |
| [`crates/discovery-service/`](crates/discovery-service/)             | HTTP discovery service (RPC-backed) ([README](crates/discovery-service/README.md))    |
| [`sdk/`](sdk/)                                                       | TypeScript SDK for private transfers ([README](sdk/README.md))                        |
| [`e2e/`](e2e/)                                                       | End-to-end tests & devnet fixture generation ([README](e2e/README.md))                |
| [`deploy/discovery-service/`](deploy/discovery-service/)             | Dockerfile & deployment ([README](deploy/discovery-service/README.md))                |
| [`lean/`](lean/)                                                     | Formal verification (Lean)                                                            |
| [`demo/`](demo/)                                                     | Web demo application                                                                  |
| [`scripts/`](scripts/)                                               | Utility scripts (devnet, deployment, etc.)                                            |
| [`docs/`](docs/)                                                     | Audit reports & security docs ([audit](docs/audit/README.md))                         |
| [`crates/discovery-service/specs/`](crates/discovery-service/specs/) | Discovery service specifications ([README](crates/discovery-service/specs/README.md)) |

## Prerequisites

### Cairo

Install [Scarb](https://docs.swmansion.com/scarb/) and [Starknet Foundry](https://foundry-rs.github.io/starknet-foundry/index.html) via [starkup](https://github.com/software-mansion/starkup):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.starkup.dev | sh
```

### Rust

Stable toolchain. Install via [rustup](https://rustup.rs/) if needed.

### Node.js

Version 20 or later.

### E2E tests

See [e2e/README.md](e2e/README.md) for additional setup requirements (devnet, `.env` generation, built artifacts).

## Build and test

```bash
scarb build && scarb test          # Cairo contract
cargo build && cargo test          # Rust crates
cd sdk && npm ci && npm test       # TypeScript SDK
cd e2e && npm ci && npm test       # E2E
```

## License

[Apache 2.0](LICENSE)

## Audit

Find the latest audit report in [docs/audit](docs/audit).

## Security

For more information and to report security issues, please refer to the [security documentation](docs/SECURITY.md).
