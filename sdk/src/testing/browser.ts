/**
 * Browser-compatible testing utilities.
 * Excludes Devnet which requires Node.js.
 */

export { ERC20, MockContracts, MockSwapHelper } from "./contracts.js";
export { MockPoolContract } from "./mock-pool-contract.js";
export {
  Mocknet,
  type MocknetOptions,
  type MockAccount,
  type MocknetEnvironment,
} from "./mocknet.js";
export { MockProofProvider } from "./mock-proof-provider.js";
export { MockProofInvocationFactory } from "./mock-proof-invocation-factory.js";
export { createMockProof, createMockCallAndProof, Withdrawal } from "./helpers.js";
export {
  compute_channel_key,
  compute_channel_marker,
  compute_subchannel_id,
  compute_subchannel_marker,
  compute_note_id,
  compute_nullifier,
  compute_enc_amount_hash,
  compute_enc_token_hash,
  compute_enc_private_key_hash,
  compute_enc_user_addr_hash,
  compute_enc_channel_key_hash,
  compute_enc_sender_addr_hash,
} from "../utils/hashes.js";
export { CallMockProofProvider } from "../internal/mock-proving.js";
export { TracingRpcProvider, TracedRpcError, type DecodedError } from "./tracing-provider.js";
export {
  ContractDiscoveryProvider,
  type PoolContractInterface,
} from "../internal/contract-discovery.js";
export {
  createConcurrencyProfiler,
  formatReport,
  type ConcurrencyReport,
  type ConcurrencyProfiler,
  type CallRecord,
} from "./concurrency-profiler.js";

// Note: Devnet is NOT exported here - it requires Node.js (fs, path, starknet-devnet)
