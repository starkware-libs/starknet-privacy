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
        Helpers[Invoke Helpers]
    end

    Wallet --> SDK
    SDK --> Discovery
    SDK --> Proving
    SDK --> Contract
    Discovery --> Contract
    Proving --> Contract
    Contract --> Helpers
```

- **SDK** — Orchestrates private transfers (register, transfer, discover)
- **Discovery Service** — Indexes encrypted on-chain storage for efficient wallet sync
- **Proving Service** — Executes actions in virtual Starknet blocks and returns validity proofs + proof facts to the SDK
- **Privacy Pool Contract** — Source of truth for actions, storage layout, cryptography
- **Invoke Helpers** — External contracts callable from within a private transaction (e.g. swap executors)

## Compatibility matrix

All components in a row are tested together. Use matching revisions when deploying.

| sequencer | proving-utils | discovery-service | proving-service | starknet-privacy-sdk |
|-----------|---------------|-------------------|-----------------|----------------------|
| [`APOLLO-PRE-PROOF-DEMO-16`](https://github.com/starkware-libs/sequencer/releases/tag/APOLLO-PRE-PROOF-DEMO-16) | [`e16f9d0`](https://github.com/starkware-libs/proving-utils/commit/e16f9d027fb026f96bfd3aeed76b41a169372f81) | [`pr-510`](https://github.com/starkware-libs/starknet-privacy/pkgs/container/starknet-privacy%2Fdiscovery-service/701186259?tag=pr-510) | [`rev-5f29e09-e16f9d0`](https://github.com/starkware-libs/starknet-privacy/pkgs/container/starknet-privacy%2Fproving-service/703346885?tag=rev-5f29e09-e16f9d0) | [`0.1.0-dev.1`](https://github.com/starkware-libs/starknet-privacy/pkgs/npm/starknet-privacy-sdk/703792073) |

## Repository map

```
starknet-privacy/
├── packages/privacy/        Cairo smart contract (Scarb workspace)
├── crates/
│   ├── discovery-core/      Core discovery logic & cryptography (Rust library)
│   └── discovery-service/   HTTP indexing service with SQLite cache (Rust binary)
├── sdk/                     TypeScript SDK for private transfers
├── e2e/                     End-to-end tests & devnet fixture generation
├── deploy/
│   ├── discovery-service/   Dockerfile & deployment docs
│   ├── proving-service/     Dockerfile & deployment docs
│   └── pathfinder/          Pathfinder + fake L1 setup
├── lean/                    Formal verification (Lean)
├── demo/                    Web demo application
├── docs/                    Audit reports & security docs
└── .claude/
    ├── CLAUDE.md            Project-level agent instructions
    ├── rules/               Code style, testing, verification rules
    └── specs/               Discovery service specifications
```

Each component directory contains its own README with architecture details, API docs, and build instructions.

## Docker images

### Discovery Service

See [deploy/discovery-service](deploy/discovery-service) for the Dockerfile, configuration reference, and run instructions.

### Proving Service

See [deploy/proving-service](deploy/proving-service) for build instructions, configuration, and the JSON-RPC interface. Images are published to `ghcr.io/starkware-libs/starknet-privacy/proving-service`.

### Pathfinder (RPC Node) + Fake L1

See [deploy/pathfinder](deploy/pathfinder) for Pathfinder configuration, blockifier constants, and the Anvil-based fake L1 setup.

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

### Starknet Devnet

This project uses a [custom fork of starknet-devnet](https://github.com/m-kus/starknet-devnet) that includes a blockifier version supporting the new transaction version with proofs. Install from the `APOLLO-PRE-PROOF-DEMO-11` release:

If you have a previous asdf installation of starknet-devnet, remove it first:

```bash
asdf plugin remove starknet-devnet
```

Then install from the release:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/m-kus/starknet-devnet/releases/download/APOLLO-PRE-PROOF-DEMO-11/starknet-devnet-aarch64-apple-darwin.tar.gz -o /tmp/starknet-devnet.tar.gz
sudo tar -xzf /tmp/starknet-devnet.tar.gz -C /usr/local/bin
sudo chmod +x /usr/local/bin/starknet-devnet
rm /tmp/starknet-devnet.tar.gz

# Linux (x86_64)
curl -L https://github.com/m-kus/starknet-devnet/releases/download/APOLLO-PRE-PROOF-DEMO-11/starknet-devnet-x86_64-unknown-linux-gnu.tar.gz -o /tmp/starknet-devnet.tar.gz
sudo tar -xzf /tmp/starknet-devnet.tar.gz -C /usr/local/bin
sudo chmod +x /usr/local/bin/starknet-devnet
rm /tmp/starknet-devnet.tar.gz
```

Verify the installation:

```bash
which starknet-devnet
# Expected: /usr/local/bin/starknet-devnet
```

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
