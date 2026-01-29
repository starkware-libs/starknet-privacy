<div align="center">
  <img alt="Cairo Logo" src="cairo_logo.png" width="200">
</div>

<div align="center">

[![License: Apache2.0](https://img.shields.io/badge/License-Apache2.0-green.svg)](LICENSE)
</div>

# Starknet Privacy Pool

A privacy-preserving smart contract system for Starknet that enables private token transfers using encrypted notes and zero-knowledge proofs.

## Content

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Installation](#installation)
- [Build and Test](#build-and-test)
- [Usage](#usage)
- [Development](#development)
- [Security](#security)
- [Formal Verification](#formal-verification)
- [Contributing](#contributing)
- [Getting Help](#getting-help)
- [License](#license)

## Overview

This repository implements a privacy pool protocol on Starknet that enables private token transfers. The system provides strong privacy guarantees through encrypted channels and notes, efficiently scales note discovery, and maintains compliance capabilities by enabling selective disclosure when required.

### Privacy

The privacy pool ensures transaction privacy through multiple layers of encryption and cryptographic techniques:

- **Encrypted Channels**: All communication between users is encrypted using ECDH (Elliptic Curve Diffie-Hellman) encryption, ensuring that channel metadata remains private
- **Encrypted Notes**: Token amounts are encrypted with recipient viewing keys, making transaction amounts invisible on-chain
- **Nullifier System**: Prevents double-spending without revealing which specific note was spent, maintaining privacy while ensuring security
- **Zero-Knowledge Proofs**: Client actions are proven off-chain with zero-knowledge proofs, allowing users to prove transaction validity without revealing private information
- **On-Chain Encryption**: All sensitive data (channel keys, note amounts, sender addresses) is encrypted before being stored on-chain

Users maintain full control over their privacy - transaction amounts, recipients, and sender identities are encrypted and can only be decrypted by authorized parties (the recipient for incoming notes, or compliance authorities when required).

### Scalability

The system is designed for high throughput and efficient operation:

- **Discovery Service**: A dedicated indexing layer that maintains a hot cache of on-chain state, transforming expensive on-chain storage reads into fast local database lookups
- **Batch Operations**: Multiple actions can be executed in a single transaction, reducing latency between operations and overall gas consumption
- **L2 Native**: Built on Starknet L2, benefiting from lower transaction costs and higher throughput compared to L1
- **Asynchronous Processing**: Proof generation and transaction execution are decoupled, allowing for parallel processing

The discovery service provides a simple, paginated API that enables wallets to efficiently discover encrypted channels and notes without performing expensive on-chain queries, making the system practical for real-world usage at scale.

### Compliance

The privacy pool maintains compliance capabilities while preserving user privacy:

- **Encrypted Private Keys**: User private keys are encrypted with a compliance public key, stored on-chain, and can only be decrypted by authorized compliance authorities
- **Selective Disclosure**: Compliance authorities can decrypt user information when legally required, enabling regulatory compliance without compromising privacy for other users
- **Audit Trail**: All transactions are recorded on-chain in encrypted form, providing an immutable audit trail that can be decrypted when necessary
- **Governance Controls**: The contract includes access control mechanisms allowing governance to manage compliance keys and contract parameters
- **Event Logging**: Compliance-relevant events (deposits, withdrawals) are emitted with appropriate encryption, enabling monitoring while maintaining privacy
- **Regulatory Compatibility**: Designed to work within existing regulatory frameworks by providing the necessary tools for compliance without requiring full transparency

The compliance model ensures that while users enjoy strong privacy guarantees, the system remains compatible with regulatory requirements through selective disclosure mechanisms that only activate when legally mandated.

### Key Components

- **Private Transfers**: Send tokens privately using encrypted channels and notes with zero-knowledge proofs
- **Scalable Architecture**: Discovery service for efficient note retrieval and batch operations for reduced latency
- **Compliance Support**: Built-in compliance mechanisms with encrypted private keys for selective disclosure
- **Channel System**: Encrypted channels and subchannels for organizing private transfers across multiple tokens
- **Note System**: Privacy-preserving notes with nullifiers to prevent double-spending while ensuring security
- **Formal Verification**: Lean proofs for critical security properties
- **TypeScript SDK**: Easy-to-use SDK for integrating privacy features into applications
- **Discovery Service**: Indexing layer for efficient discovery of encrypted channels and notes

## Quick Start

Get started with the privacy pool in minutes:

1. **Install dependencies**:
   ```bash
   # Install the Cairo/Starknet toolchain
   curl --proto '=https' --tlsv1.2 -sSf https://sh.starkup.dev | sh
   ```

2. **Clone and build**:
   ```bash
   git clone https://github.com/starkware-libs/starknet-privacy.git
   cd starknet-privacy
   scarb build
   ```

3. **Run tests**:
   ```bash
   scarb test
   ```

4. **Use the SDK** in your application:
   ```typescript
   import { PrivateTransfers } from '@starknet-privacy/sdk';
   const privateTransfers = new PrivateTransfers({ contractAddress: '...' });
   ```

For detailed setup instructions, see the [Installation](#installation) section. For usage examples, see the [Usage](#usage) section.

## Project Structure

### Components

| Component | Description | Documentation |
|-----------|-------------|---------------|
| [Privacy Contract](packages/privacy) | Core Cairo smart contract implementing privacy features | [Privacy README](packages/privacy/README.md) |
| [TypeScript SDK](sdk) | Client SDK for interacting with the privacy contract | [SDK README](sdk/README.md) |
| [Discovery Service](crates/discovery-service) | Indexing service for discovering encrypted channels and notes | [Discovery Service README](crates/discovery-service/README.md) |
| [Discovery Core](crates/discovery-core) | Core library for discovery functionality | [Discovery Core README](crates/discovery-core/README.md) |
| [Formal Verification](lean) | Lean proofs for security properties | See `lean/` directory |

### Directory Structure

```
starknet-privacy/
├── packages/privacy/          # Cairo smart contract
│   ├── src/                  # Contract source code
│   └── tests/                # Contract tests
├── sdk/                      # TypeScript SDK
│   ├── src/                  # SDK source code
│   └── tests/                # SDK tests
├── crates/                   # Rust components
│   ├── discovery-core/       # Discovery core library
│   └── discovery-service/    # Discovery service binary
├── lean/                     # Formal verification proofs
├── docs/                     # Documentation
└── scripts/                  # Utility scripts
```

## Installation

### Prerequisites

The following tools are required:

- **Cairo/Starknet**: [Scarb](https://docs.swmansion.com/scarb/) and [Starknet Foundry](https://foundry-rs.github.io/starknet-foundry/index.html)
- **Rust**: For discovery service components
- **Node.js**: For TypeScript SDK
- **Python**: For integration tests

### Step-by-Step Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/starkware-libs/starknet-privacy.git
   cd starknet-privacy
   ```

2. **Install Cairo/Starknet toolchain**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.starkup.dev | sh
   ```
   
   This installs Scarb (Cairo package manager) and Starknet Foundry (testing framework).

3. **Install Rust** (for discovery service):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

4. **Install Node.js** (for SDK):
   ```bash
   # Using nvm (recommended)
   nvm install node
   # or download from https://nodejs.org/
   ```

5. **Install Python dependencies** (for integration tests):
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r py_requirements.txt
   ```

### Verify Installation

Check that all tools are installed correctly:

```bash
# Check Scarb
scarb --version

# Check Starknet Foundry
snforge --version

# Check Rust
rustc --version
cargo --version

# Check Node.js
node --version
npm --version

# Check Python
python3 --version
```

## Build and Test

### Building Components

**Build the Privacy Contract**:
```bash
scarb build
```

This generates:
- Sierra code: `target/dev/privacy.sierra.json`
- Compiled contract class: `target/dev/privacy_Privacy.compiled_contract_class.json`
- Starknet artifacts: `target/dev/privacy.starknet_artifacts.json`

**Build the TypeScript SDK**:
```bash
cd sdk
npm install
npm run build
```

**Build Discovery Service**:
```bash
cargo build --release
```

**Build All Components**:
```bash
scarb build && cd sdk && npm install && npm run build && cd .. && cargo build --release
```

### Running Tests

**Cairo Contract Tests**:
```bash
scarb test
# or with debugging
SNFORGE_BACKTRACE=1 snforge test
```

Test files in `packages/privacy/src/tests/`:
- `test_client.cairo` - Client action tests
- `test_server.cairo` - Server action tests
- `test_views.cairo` - View function tests
- `test_compliance.cairo` - Compliance tests
- `test_hashes.cairo` - Hash function tests
- `test_objects.cairo` - Object serialization tests
- `test_utils.cairo` - Utility function tests

**TypeScript SDK Tests**:
```bash
cd sdk && npm test
```

**Rust Discovery Service Tests**:
```bash
cargo test
```

**Python Integration Tests**:
```bash
pytest tests/
```

## Usage

### Using the TypeScript SDK

The TypeScript SDK provides a high-level interface for building privacy-enabled applications. See the [SDK README](sdk/README.md) for complete documentation.

**Basic Example**:
```typescript
import { PrivateTransfers } from '@starknet-privacy/sdk';

// Initialize the SDK
const privateTransfers = new PrivateTransfers({
  contractAddress: '0x...',
  // ... configuration options
});

// Register a user with a viewing key
await privateTransfers.register(viewingKey);

// Make a private transfer
await privateTransfers.transfer({
  recipient: recipientAddress,
  token: tokenAddress,
  inputs: noteInputs,
  amount: transferAmount
});

// Discover incoming notes
const incomingNotes = await privateTransfers.discover({
  lastBlock: lastKnownBlock,
  recipient: userAddress
});
```

### Contract Interfaces

The privacy contract exposes four main interfaces:

**IClient**: Execute client actions (user-facing operations)
- `__execute__`: Process client actions and send server actions to L1
- `execute_view`: Compile client actions to server actions (view function)
- `__validate__`: Validate transaction

**IServer**: Execute server actions (on-chain state updates)
- `execute_actions`: Execute server actions atomically

**IViews**: Query contract state
- `channel_exists`, `get_channel_info`: Channel queries
- `get_note`, `nullifier_exists`: Note and nullifier queries
- `get_public_key`, `get_enc_private_key`: Key queries
- And more...

**ICompliance**: Manage compliance keys
- `set_compliance_public_key`: Set compliance public key (governance only)

See the [contract interface documentation](packages/privacy/src/interface.cairo) for detailed function signatures.

### Client Actions

The contract supports seven client actions:

1. **SetViewingKey**: Register a user with a viewing key
2. **OpenChannel**: Create an encrypted channel to a recipient
3. **OpenSubchannel**: Create a token-specific subchannel
4. **Deposit**: Deposit tokens into the privacy pool
5. **UseNote**: Spend a note (creates a nullifier)
6. **CreateNote**: Create a new note for a recipient
7. **Withdraw**: Withdraw tokens from the privacy pool

### Server Actions

Client actions compile into server actions that execute on-chain:

- **WriteOnce**: Write a value to storage (fails if already set)
- **AppendToVec**: Append encrypted channel info to recipient's vector
- **TransferFrom**: Transfer tokens from user to contract via ERC20
- **TransferTo**: Transfer tokens from contract to recipient via ERC20
- **VerifyValue**: Verify a storage value matches expected value
- **EmitViewingKeySet**: Emit ViewingKeySet event
- **EmitDeposit**: Emit Deposit event
- **EmitWithdrawal**: Emit Withdrawal event

## Development

### Development Workflow

1. Fork and clone the repository
2. Set up the development environment (see [Installation](#installation))
3. Create a feature branch
4. Make your changes
5. Run tests and format code
6. Submit a pull request

### Code Style

Format code before committing:

```bash
# Cairo
scarb fmt

# TypeScript
cd sdk && npm run lint && cd ..

# Python
black .

# Rust
cargo fmt
```

### Testing

The project uses multiple testing strategies:

- **Unit Tests**: Test individual functions and modules
- **Integration Tests**: Test component interactions
- **Flow Tests**: Test complete user flows (deposit → transfer → withdraw)
- **Formal Verification**: Mathematical proofs in Lean

Run all tests:
```bash
scarb test && cd sdk && npm test && cd .. && cargo test && pytest tests/
```

### Debugging

**Enable Cairo Debug Info**:
```toml
# In Scarb.toml
[profile.dev.cairo]
unstable-add-statements-code-locations-debug-info = true
unstable-add-statements-functions-debug-info = true
```

**Debug Commands**:
```bash
# Detailed error traces
SNFORGE_BACKTRACE=1 snforge test

# Query contract state
starknet call --address <CONTRACT> --function get_public_key --inputs <USER_ADDRESS>
```

## Security

### Security Features

- **Encryption**: All sensitive data is encrypted before being stored on-chain
- **Double-Spend Prevention**: Nullifiers ensure notes can only be spent once
- **Replay Protection**: Transaction signatures and validation prevent replay attacks
- **Atomicity**: All actions in a transaction execute atomically
- **Access Control**: OpenZeppelin's AccessControl for administrative functions
- **Pausability**: Contract can be paused by authorized roles in emergencies
- **Formal Verification**: Critical properties are mathematically proven

### Security Considerations

- **Private Key Management**: Users must securely store their private keys and viewing keys
- **Compliance Keys**: Compliance public keys are set by governance and used to encrypt user private keys
- **Key Storage**: Never share private keys; use secure storage solutions

### Reporting Security Issues

**Important**: Do not open public GitHub issues for security vulnerabilities.

For security issues, please refer to our [security documentation](docs/SECURITY.md) and follow the reporting process outlined there.

## Audit

Find the latest audit report in [docs/audit](docs/audit).

**Disclaimer**: This repository follows security best practices, but 100% security cannot be assured. This repository is provided "as is" without any warranty. Use at your own risk.

## Formal Verification

The project includes formal verification proofs in Lean. See the [lean/](lean/) directory for proofs of critical security properties including:

- **Privacy guarantees**: Proves that transaction details remain private
- **Note spendability**: Ensures notes can be spent correctly
- **Channel and subchannel integrity**: Verifies channel structure and relationships
- **Transaction immutability**: Proves transactions cannot be modified after execution
- **No replay attacks**: Ensures transactions cannot be replayed
- **Contiguous channels**: Verifies channels are created sequentially
- **Discoverable notes**: Proves notes can be discovered by recipients
- **Compliance**: Verifies compliance mechanisms work correctly

To build and verify the Lean proofs:

```bash
cd lean
lake build
```

## Contributing

We welcome contributions! Please read [CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) before contributing.

### How to Contribute

1. Fork the repository
2. Create a feature branch
3. Make your changes following the code style guidelines
4. Add tests for new functionality
5. Ensure all tests pass
6. Update documentation
7. Submit a pull request with a clear description

### Contribution Areas

- **Smart Contract**: Improve the privacy contract (`packages/privacy/`)
- **SDK**: Enhance the TypeScript SDK (`sdk/`)
- **Discovery Service**: Improve indexing (`crates/discovery-service/`)
- **Formal Verification**: Add or improve Lean proofs (`lean/`)
- **Documentation**: Improve docs and examples
- **Testing**: Add tests and improve coverage

### Checklist

Before submitting a PR, ensure:
- ✅ All tests pass
- ✅ Code is formatted
- ✅ Documentation is updated
- ✅ Security implications are considered

## Getting Help

### Documentation

- **Main Documentation**: This README
- **Privacy Contract**: [packages/privacy/README.md](packages/privacy/README.md)
- **TypeScript SDK**: [sdk/README.md](sdk/README.md)
- **Discovery Service**: [crates/discovery-service/README.md](crates/discovery-service/README.md)
- **Formal Verification**: See `lean/` directory

### Support Channels

Reach out to the maintainers at:

- [GitHub Discussions](https://github.com/starkware-libs/starknet-privacy/discussions) - Ask questions and discuss
- [GitHub Issues](https://github.com/starkware-libs/starknet-privacy/issues) - Report bugs and request features
- Contact options listed on this [GitHub profile](https://github.com/starkware-libs)

### Common Questions

**Q: How do I deploy the contract?**  
A: Use `scarb build` to compile, then deploy using Starknet CLI or your preferred deployment tool. See the Privacy Contract README for constructor parameters.

**Q: How do I generate proofs?**  
A: You need to implement a proof backend that integrates with the SDK's `ProveInterface`. The SDK handles proof generation flow.

**Q: How do I discover incoming notes?**  
A: Use the discovery service or query the contract directly using view functions. See the Discovery Service README for details.

**Q: What tokens are supported?**  
A: Any ERC20-compatible token on Starknet can be used with the privacy pool.

## License

This project is licensed under the Apache 2.0 License - see the [LICENSE](LICENSE) file for details.
