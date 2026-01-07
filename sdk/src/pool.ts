/**
 * Pool - implements PrivateTransfers interface for interacting with the privacy pool contract.
 * Currently implements isRegistered and register methods; others are TODO.
 */

import {
  Contract,
  CairoCustomEnum,
  cairo,
  transaction,
  type AccountInterface,
  type Call,
  type BlockIdentifier,
  type Abi,
} from "starknet";

import type {
  PrivateTransfers,
  PrivateTransfersConfig,
  CallAndProof,
  PrivateRecipient,
  StarknetAddress,
  Amount,
  Note,
  PrivateInvocationResult,
  PrivateTransfersBuilder,
  ProofProviderInterface,
  ViewingKey,
} from "./interfaces.js";
import { Channel } from "./internal.js";

/**
 * Pool implements the PrivateTransfers interface for interacting with
 * the privacy pool contract on Starknet.
 */
export class Pool implements PrivateTransfers {
  private readonly account: AccountInterface;
  private readonly viewingKey: ViewingKey;
  private readonly proofProvider: ProofProviderInterface;
  private readonly poolAddress: StarknetAddress;
  private readonly contract: Contract;

  constructor(config: PrivateTransfersConfig, abi: Abi) {
    this.account = config.account;
    this.viewingKey = config.viewingSigner;
    this.proofProvider = config.provingProvider;
    this.poolAddress = config.pool;

    // Create contract instance with account for read/write access
    this.contract = new Contract({
      abi,
      address: config.pool.toString(),
      providerOrAccount: config.account,
    });
  }

  /**
   * Check if the current user is registered in the privacy pool.
   * Uses the get_public_key view method - returns true if the public key is non-zero.
   */
  async isRegistered(): Promise<boolean> {
    const publicKey = await this.contract.get_public_key(this.account.address);
    // If public key is 0, user is not registered
    return BigInt(publicKey.toString()) !== 0n;
  }

  /**
   * Register the current user in the privacy pool with their viewing key.
   *
   * @param random - Random value for encryption (must be non-zero, 120 bits max)
   *
   * Steps:
   * 1. Build ClientAction::SetViewingKey with the viewing key and random
   * 2. Call compile_client_actions to get ServerAction calldata
   * 3. Use proof provider to simulate and get execution result
   * 4. Build execute_actions call with the ServerAction calldata
   * 5. Return CallAndProof
   */
  async register(random: bigint): Promise<CallAndProof> {
    if (random === 0n) {
      throw new Error("Random value must be non-zero");
    }

    // Build ClientAction::SetViewingKey enum variant using CairoCustomEnum
    // SetViewingKey variant contains tuple (user_private_key, random)
    const clientAction = new CairoCustomEnum({
      SetViewingKey: cairo.tuple(this.viewingKey, random),
    });

    // Build call to compile_client_actions
    const compileCall = this.contract.populate("compile_client_actions", {
      user_addr: this.account.address,
      client_actions: [clientAction],
    });

    // Build invocation for the proof provider
    // We need to simulate the account's __execute__ call with the compile_client_actions call
    const calldata = transaction.getExecuteCalldata([compileCall], "1");

    const invocation = {
      contractAddress: this.account.address,
      calldata,
      signature: [], // Empty signature - validation is skipped in simulation
    };

    // Get proof (simulated execution result)
    const proof = await this.proofProvider.prove(invocation);

    // The proof output from __execute__ has a multicall wrapper:
    // Format: [retval_count, retval_size, ...actual_return_data]
    // - retval_count: number of return values (1 for single call)
    // - retval_size: size in felts of this return value
    // - actual_return_data: the serialized Span<ServerAction>
    // We skip the first 2 elements to get the raw Span<ServerAction> calldata.
    const serverActionsCalldata = proof.output.slice(2);

    // Build the execute_actions call with the server actions
    const executeCall: Call = {
      contractAddress: this.poolAddress.toString(),
      entrypoint: "execute_actions",
      calldata: serverActionsCalldata,
    };

    return {
      call: executeCall,
      proof,
    };
  }

  // ============ TODO: Implement remaining PrivateTransfers methods ============

  async setupRequirement(
    _recipient: PrivateRecipient,
    _token: StarknetAddress
  ): Promise<{ register: boolean; initial: boolean; token: boolean }> {
    throw new Error("Not implemented");
  }

  async setupInitial(
    _recipient: StarknetAddress
  ): Promise<{ invocationData: CallAndProof; channel: Channel }> {
    throw new Error("Not implemented");
  }

  async setupToken(
    _recipient: PrivateRecipient,
    _token: StarknetAddress
  ): Promise<{ invocationData: CallAndProof; channel: Channel }> {
    throw new Error("Not implemented");
  }

  async deposit(_params: {
    token: StarknetAddress;
    amount: Amount;
    recipient: PrivateRecipient;
  }): Promise<PrivateInvocationResult> {
    throw new Error("Not implemented");
  }

  async withdraw(_params: {
    token: StarknetAddress;
    inputs: Note[];
    recipient?: StarknetAddress;
    amount?: Amount;
    selfChannel?: Channel;
  }): Promise<PrivateInvocationResult> {
    throw new Error("Not implemented");
  }

  async transfer(_params: {
    token: StarknetAddress;
    inputs: Note[];
    recipient: PrivateRecipient;
    amount?: Amount;
    selfChannel?: Channel;
  }): Promise<PrivateInvocationResult> {
    throw new Error("Not implemented");
  }

  build(): PrivateTransfersBuilder {
    throw new Error("Not implemented");
  }

  discoverNotes(_params: { since?: BlockIdentifier; known?: Map<StarknetAddress, Note[]> }): {
    timestamp: BlockIdentifier;
    notes: Map<StarknetAddress, Note[]>;
  } {
    throw new Error("Not implemented");
  }

  discoverChannels(..._recipients: (StarknetAddress | PrivateRecipient)[]): {
    timestamp: BlockIdentifier;
    channels: Map<StarknetAddress, Channel>;
  } {
    throw new Error("Not implemented");
  }
}
