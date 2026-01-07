/**
 * Simulated execution (e.g. in devnet), mocked proving
 * Intended for e2e tests.
 *
 * Uses starknet.js simulateTransaction to validate that the transaction
 * would execute successfully, then returns a mock proof and the execution result.
 */

import {
  RpcProvider,
  Invocation,
  TransactionType,
  type AccountInvocations,
  type BigNumberish,
  type SimulateTransactionResponse,
  ETransactionVersion3,
  EDataAvailabilityMode,
} from "starknet";
import { Proof, ProofProviderInterface } from "../interfaces.js";

export interface SimulatedProofProviderOptions {
  /** Starknet RPC node URL */
  nodeUrl: string;
  /** Optional nonce to use for simulation (defaults to fetching from chain) */
  nonce?: BigNumberish;
}

/**
 * A proof provider that simulates transaction execution on a Starknet node
 * and returns mock proofs. Intended for integration testing against devnet/testnet.
 */
export class SimulatedProofProvider implements ProofProviderInterface {
  private readonly provider: RpcProvider;
  private readonly options: SimulatedProofProviderOptions;

  constructor(options: SimulatedProofProviderOptions) {
    this.options = options;
    this.provider = new RpcProvider({ nodeUrl: options.nodeUrl });
  }

  /**
   * Simulates the transaction to validate it would execute successfully,
   * then returns a mock proof.
   *
   * @param invocation - The signed invocation to prove
   * @returns A mock proof with simulation results
   * @throws If the simulation fails (transaction would revert)
   */
  async prove(invocation: Invocation): Promise<Proof> {
    // Get nonce from chain if not provided
    const nonce =
      this.options.nonce ?? (await this.provider.getNonceForAddress(invocation.contractAddress));

    // Build AccountInvocations for simulation
    // The contractAddress in Invocation is the account address (sender)
    const accountInvocations: AccountInvocations = [
      {
        type: TransactionType.INVOKE,
        contractAddress: invocation.contractAddress,
        calldata: invocation.calldata,
        signature: invocation.signature,
        nonce,
        version: ETransactionVersion3.V3,
        resourceBounds: {
          l1_gas: { max_amount: 0x186a0n, max_price_per_unit: 0x5af3107a4000n },
          l2_gas: { max_amount: 0n, max_price_per_unit: 0n },
          l1_data_gas: { max_amount: 0x186a0n, max_price_per_unit: 0x5af3107a4000n },
        },
        tip: 0n,
        paymasterData: [],
        accountDeploymentData: [],
        nonceDataAvailabilityMode: EDataAvailabilityMode.L1,
        feeDataAvailabilityMode: EDataAvailabilityMode.L1,
      },
    ];

    // Simulate the transaction
    const simulationResult = await this.provider.channel.simulateTransaction(accountInvocations, {
      skipValidate: true,
      skipFeeCharge: true,
    });

    // Check if simulation succeeded
    if (!simulationResult || simulationResult.length === 0) {
      throw new Error("Simulation returned no results");
    }

    const txResult = (simulationResult as SimulateTransactionResponse)[0];
    const trace = txResult.transaction_trace;

    // Verify this is an invoke transaction
    if (trace.type !== "INVOKE") {
      throw new Error(`Unexpected transaction type: ${trace.type}`);
    }

    const executeInvocation = trace.execute_invocation;

    // Check for revert
    if ("revert_reason" in executeInvocation) {
      throw new Error(`Transaction simulation reverted: ${executeInvocation.revert_reason}`);
    }

    // Extract execution result (string[] of felt values, which are BigNumberish)
    const executionResult = executeInvocation.result as BigNumberish[];

    // Return a mock proof with the execution result
    // In integration tests, we don't need actual ZK proofs
    return {
      data: new Uint8Array(),
      outputHash: 0n,
      output: executionResult,
    };
  }
}
