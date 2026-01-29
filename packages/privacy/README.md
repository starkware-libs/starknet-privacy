# Privacy Contract

The core Cairo smart contract implementing privacy-preserving token transfers on Starknet using encrypted channels, notes, and zero-knowledge proofs.

## Content

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Key Concepts](#key-concepts)
- [Contract Interfaces](#contract-interfaces)
- [Actions](#actions)
- [Storage and Encryption](#storage-and-encryption)
- [Testing](#testing)
- [Security](#security)
- [Integration](#integration)
- [Documentation](#documentation)

## Overview

The Privacy contract enables private token transfers through a privacy pool model where transaction details are encrypted on-chain. The contract maintains compliance capabilities through encrypted private keys that enable selective disclosure when required.

### Key Features

- **Encrypted Channels**: Private communication paths between users using ECDH encryption
- **Encrypted Notes**: Privacy-preserving commitments representing token amounts
- **Nullifier System**: Prevents double-spending while maintaining privacy
- **Compliance Support**: Encrypted private keys for regulatory compliance
- **Atomic Execution**: All actions execute atomically or not at all
- **Formal Verification**: Critical properties proven in Lean

## Quick Start

1. **Build the contract**:
   ```bash
   scarb build
   ```

2. **Run tests**:
   ```bash
   scarb test
   ```

3. **Deploy** with governance and compliance keys:
   ```cairo
   constructor(
       governance_admin: ContractAddress,
       compliance_public_key: felt252
   )
   ```

4. **Interact** using the TypeScript SDK or directly via contract interfaces.

## Architecture

### Contract Structure

The contract is organized into the following modules:

```
src/
├── lib.cairo              # Module exports
├── privacy.cairo          # Main contract implementation
├── interface.cairo        # Contract interfaces
├── actions.cairo          # Client and server action definitions
├── objects.cairo          # Data structures
├── hashes.cairo           # Hash functions and domain separation
├── events.cairo           # Event definitions
├── errors.cairo           # Error constants
├── utils.cairo            # Utility functions
└── tests/                 # Test suite
```

### Contract Interfaces

The contract implements four main interfaces:

- **IClient**: Processes client actions and compiles them into server actions
- **IServer**: Executes server actions atomically on-chain
- **IViews**: Provides read-only access to contract state
- **ICompliance**: Manages compliance public keys

### Execution Model

The contract uses a two-phase execution model:

1. **Client Phase (Off-Chain)**:
   - User creates client actions
   - Actions are compiled into server actions
   - Zero-knowledge proofs are generated
   - Server actions and proofs are sent to L1

2. **Server Phase (On-Chain)**:
   - Server actions are received from L1
   - Actions execute atomically
   - State is updated (channels, notes, nullifiers)
   - Events are emitted
   - Token transfers are executed

## Key Concepts

### Channels

Encrypted communication paths between users:
- Encrypted using ECDH (Elliptic Curve Diffie-Hellman)
- Organized by recipient address
- Identified by unique channel ID (sender, recipient, index)
- Stored as `EncChannelInfo` with encrypted channel key and sender address

### Subchannels

Token-specific channels within a channel:
- Each subchannel associated with a specific ERC20 token
- Enables multi-token support per channel
- Identified by subchannel key (channel key, token, index)
- Stored as `EncSubchannelInfo` with encrypted token address

### Notes

Encrypted commitments representing token amounts:
- Similar to UTXOs in privacy-preserving systems
- Encrypted with recipient's viewing key
- Identified by note ID (channel key, token, note index, salt)
- Can only be spent once (via nullifiers)

### Nullifiers

Prevent double-spending:
- Created when a note is spent
- Computed from channel key, token, and note index
- Stored on-chain permanently
- Cannot be reused (enforced by `WriteOnce`)

### Viewing Keys

Enable users to decrypt incoming notes:
- Public viewing key derived from private key
- Private keys encrypted with compliance public key
- Users decrypt channels and notes using their private key

## Contract Interfaces

### IClient

Processes client actions and compiles them into server actions:

- `__execute__`: Validates execution context, processes client actions, sends server actions to L1
- `execute_view`: Processes client actions and returns compiled server actions (view function)
- `execute_and_panic`: Internal function that processes actions and panics with result
- `__validate__`: Transaction validation (always returns VALIDATED)

### IServer

Executes server actions atomically on-chain:

- `execute_actions`: Executes a span of server actions in sequence, all-or-nothing

### IViews

Query contract state:

- `channel_exists`: Check if a channel exists
- `get_num_of_channels`: Get number of channels for a recipient
- `get_channel_info`: Get encrypted channel information
- `subchannel_exists`: Check if a subchannel exists
- `get_subchannel_info`: Get encrypted subchannel information
- `get_outgoing_channel_info`: Get encrypted outgoing channel information
- `get_note`: Get encrypted note value
- `nullifier_exists`: Check if a nullifier exists
- `get_public_key`: Get user's public viewing key
- `get_enc_private_key`: Get user's encrypted private key
- `get_compliance_public_key`: Get compliance public key

### ICompliance

Manage compliance keys:

- `set_compliance_public_key`: Set the compliance public key (governance only)

See `src/interface.cairo` for detailed function documentation.

## Actions

### Client Actions

The contract supports seven client actions:

#### SetViewingKey

Register a user with a viewing key:

```cairo
SetViewingKey {
    random: felt252  // Random value for encryption
}
```

**Server Actions**: WriteOnce (public key), WriteOnce (encrypted private key), EmitViewingKeySet

#### OpenChannel

Open an encrypted channel to a recipient:

```cairo
OpenChannel {
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
    index: usize,
    random: felt252,
    salt: felt252
}
```

**Server Actions**: VerifyValue, WriteOnce (channel exists), AppendToVec, WriteOnce (outgoing channel)

#### OpenSubchannel

Open a token-specific subchannel:

```cairo
OpenSubchannel {
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
    channel_key: felt252,
    index: usize,
    token: ContractAddress,
    salt: felt252
}
```

**Server Actions**: WriteOnce (subchannel exists), WriteOnce (encrypted subchannel info)

#### Deposit

Deposit tokens into the privacy pool:

```cairo
Deposit {
    token: ContractAddress,
    amount: u128
}
```

**Server Actions**: TransferFrom, EmitDeposit

#### UseNote

Spend a note (mark it as used):

```cairo
UseNote {
    channel_key: felt252,
    token: ContractAddress,
    note_index: usize
}
```

**Server Actions**: WriteOnce (nullifier)

#### CreateNote

Create a new note for a recipient:

```cairo
CreateNote {
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
    token: ContractAddress,
    amount: u128,
    index: usize,
    salt: u128  // Must be >= 2 and <= 2^120
}
```

**Server Actions**: WriteOnce (encrypted note)

#### Withdraw

Withdraw tokens from the privacy pool:

```cairo
Withdraw {
    withdrawal_target: ContractAddress,
    token: ContractAddress,
    amount: u128,
    random: felt252
}
```

**Server Actions**: TransferTo, EmitWithdrawal

### Server Actions

Server actions are executed atomically by `IServer::execute_actions`:

- **WriteOnce**: Verify storage is empty, then write value
- **AppendToVec**: Append value to a vector in storage
- **TransferFrom**: Transfer tokens from user to contract via ERC20
- **TransferTo**: Transfer tokens from contract to recipient via ERC20
- **VerifyValue**: Verify storage value matches expected value
- **EmitViewingKeySet**: Emit ViewingKeySet event
- **EmitDeposit**: Emit Deposit event
- **EmitWithdrawal**: Emit Withdrawal event

## Storage and Encryption

### Storage Layout

The contract stores:

- `recipient_channels`: Map of recipient address → vector of encrypted channels
- `outgoing_channels`: Map of outgoing channel key → encrypted recipient address
- `channel_exists`: Map of channel ID → existence flag
- `subchannel_tokens`: Map of subchannel key → encrypted token address
- `subchannel_exists`: Map of subchannel ID → existence flag
- `notes`: Map of note ID → encrypted note value
- `nullifiers`: Map of nullifier → existence flag
- `public_key`: Map of user address → public viewing key
- `enc_private_key`: Map of user address → encrypted private key
- `compliance_public_key`: Compliance public key for encryption

### Encryption

The contract uses ECDH-based encryption for all sensitive data:

1. **Channel Encryption**: Uses recipient's public key to encrypt channel information
2. **Note Encryption**: Uses recipient's viewing key to encrypt note amounts
3. **Private Key Encryption**: Uses compliance public key to encrypt user private keys
4. **Domain Separation**: All hashes use domain-separation tags to prevent collisions

See `src/hashes.cairo` for encryption and hashing functions.

### Error Handling

The contract defines comprehensive error constants in `src/errors.cairo`:

- **Validation errors**: `ZERO_RECIPIENT_ADDR`, `ZERO_TOKEN`, `ZERO_AMOUNT`, etc.
- **State errors**: `NON_ZERO_VALUE`, `VALUE_MISMATCH`, `NOTE_NOT_FOUND`, etc.
- **Authentication errors**: `INVALID_SIGNATURE`, `SENDER_NOT_AUTHENTICATED`, etc.
- **Ordering errors**: `ACTIONS_OUT_OF_ORDER`, `INDEX_NOT_SEQUENTIAL`, etc.

### Events

The contract emits the following events:

- **ViewingKeySet**: Emitted when a user registers a viewing key
- **Deposit**: Emitted when tokens are deposited
- **Withdrawal**: Emitted when tokens are withdrawn
- **CompliancePublicKeySet**: Emitted when compliance key is updated

## Testing

### Test Suite

The contract includes comprehensive tests in `src/tests/`:

- `test_client.cairo`: Client action tests
- `test_server.cairo`: Server action tests
- `test_views.cairo`: View function tests
- `test_compliance.cairo`: Compliance tests
- `test_hashes.cairo`: Hash function tests
- `test_objects.cairo`: Object serialization tests
- `test_utils.cairo`: Utility function tests
- `utils_for_tests.cairo`: Shared test utilities

### Running Tests

```bash
# Run all tests
scarb test

# Run with backtrace for debugging
SNFORGE_BACKTRACE=1 snforge test

# Run specific test file
snforge test --exact test_client
```

### Test Coverage

The test suite covers:
- ✅ All client actions and validation
- ✅ All server actions and execution
- ✅ All view functions
- ✅ Error conditions and edge cases
- ✅ Encryption and decryption
- ✅ Hash functions and domain separation
- ✅ Object serialization
- ✅ Storage operations
- ✅ Event emissions
- ✅ Compliance functionality

## Security

### Security Features

1. **Encryption**: All sensitive data encrypted before storage
2. **Double-Spend Prevention**: Nullifiers ensure notes can only be spent once
3. **Atomicity**: All actions execute atomically
4. **WriteOnce Protection**: Prevents overwrites and ensures immutability
5. **Signature Validation**: All client actions require valid signatures
6. **Replay Protection**: Transaction signatures prevent replay attacks
7. **Access Control**: OpenZeppelin's AccessControl for administrative functions

### Security Considerations

- **Private Keys**: Must be securely stored; encrypted on-chain with compliance key
- **Viewing Keys**: Public keys stored on-chain; private keys needed for decryption
- **Nullifiers**: Reveal that a note was spent (not amount or recipient)
- **Channel Ordering**: Must be created sequentially (index 0, 1, 2, ...)
- **Salt Requirements**: Notes require salts >= 2 and <= 2^120

### Best Practices

- Use secure key storage solutions (hardware wallets, secure enclaves)
- Use cryptographically secure random number generators for salts
- Handle errors gracefully in client applications
- Thoroughly test all flows before deploying to mainnet
- Monitor contract events and state changes
- Understand compliance requirements in your jurisdiction

## Integration

### 1. Deploy the Contract

Deploy with required constructor parameters:

```cairo
constructor(
    governance_admin: ContractAddress,
    compliance_public_key: felt252
)
```

- `governance_admin`: Address with admin privileges
- `compliance_public_key`: Public key for encrypting user private keys

### 2. Use the TypeScript SDK

The SDK provides a high-level interface:

```typescript
import { PrivateTransfers } from '@starknet-privacy/sdk';

const privateTransfers = new PrivateTransfers({
  contractAddress: deployedContractAddress,
  // ... configuration
});
```

See [SDK README](../../sdk/README.md) for detailed usage.

### 3. Set Up Discovery Service

The discovery service indexes encrypted channels and notes:
- Indexes on-chain storage changes
- Provides decrypted, filtered results
- Supports pagination and cursor-based queries

See [Discovery Service README](../../crates/discovery-service/README.md) for setup.

### 4. Implement Proof Backend

Client actions require zero-knowledge proofs:
- Implement proof generation backend
- Integrate with SDK's `ProveInterface`
- Generate proofs for client actions before execution

### Integration Checklist

- [ ] Deploy contract with governance and compliance keys
- [ ] Set up TypeScript SDK with contract address
- [ ] Configure proof backend for ZK proofs
- [ ] Set up discovery service
- [ ] Implement user registration flow
- [ ] Implement deposit flow
- [ ] Implement transfer flow
- [ ] Implement withdrawal flow
- [ ] Implement note discovery flow
- [ ] Add error handling
- [ ] Test end-to-end flows

## Documentation

### Code Documentation

- **Interface Documentation**: `src/interface.cairo` - Detailed function documentation
- **Action Documentation**: `src/actions.cairo` - Action input structures
- **Object Documentation**: `src/objects.cairo` - Data structure definitions
- **Hash Documentation**: `src/hashes.cairo` - Hash functions and domain separation
- **Error Documentation**: `src/errors.cairo` - Error constants

### External Documentation

- **Formal Verification**: `../../lean/` - Security proofs
- **SDK Documentation**: `../../sdk/README.md` - SDK usage
- **Discovery Service**: `../../crates/discovery-service/README.md` - Discovery setup
- **Main README**: `../../README.md` - Project overview

### API Reference

**IClient**:
- `__execute__`: Execute client actions and send to L1
- `execute_view`: Compile client actions to server actions (view)
- `__validate__`: Validate transaction

**IServer**:
- `execute_actions`: Execute server actions atomically

**IViews**:
- `channel_exists`, `get_channel_info`: Channel queries
- `get_note`, `nullifier_exists`: Note queries
- `get_public_key`, `get_enc_private_key`: Key queries
- And more...

**ICompliance**:
- `set_compliance_public_key`: Set compliance key (governance only)

## License

This package is part of the Starknet Privacy Pool project and is licensed under the Apache 2.0 License - see the [LICENSE](../../LICENSE) file for details.
