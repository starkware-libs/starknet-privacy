/**
 * Call-based proving provider for testing
 *
 * This provider simulates proof generation by making a call to the contract
 * to execute the invocation and capture the output.
 */

import type { BigNumberish, ProviderInterface } from "starknet";
import { ETransactionVersion, hash, num, transaction, type EDAMode } from "starknet";
import type {
  Proof,
  ProofProviderInterface,
  ProofInvocation,
  ProofInvocationFactoryDetails,
} from "../interfaces.js";

/** VALIDATED constant - 'VALID' encoded as short string felt252 */
const VALIDATED = "0x56414c4944";

/** Convert DA mode string to numeric value for hash calculation */
function daToInt(dam: string): EDAMode {
  if (dam === "L1") return 0 as EDAMode;
  if (dam === "L2") return 1 as EDAMode;
  throw new Error(`Unknown DA mode: ${dam}`);
}

/** Convert signature to array of hex strings */
function signatureToArray(sig: unknown): string[] {
  if (!sig) return [];
  // Handle array format (e.g., string[])
  if (Array.isArray(sig)) {
    return sig.map((s) => num.toHex(s));
  }
  // Handle Signature object format { r, s, recovery }
  if (typeof sig === "object" && "r" in sig && "s" in sig) {
    const sigObj = sig as { r: BigNumberish; s: BigNumberish };
    return [num.toHex(sigObj.r), num.toHex(sigObj.s)];
  }
  return [];
}

/**
 * A proving provider that uses Starknet calls to simulate proof generation.
 * This is useful for testing where we want to execute the contract logic
 * without actually generating zero-knowledge proofs.
 */
export class CallMockProofProvider implements ProofProviderInterface {
  constructor(
    private readonly provider: ProviderInterface,
    private readonly chainId: string
  ) {}

  getDefaultDetails(): ProofInvocationFactoryDetails {
    return {
      versions: [ETransactionVersion.V3],
      nonce: 0n,
      skipValidate: true,
      resourceBounds: {
        l1_gas: { max_amount: 0n, max_price_per_unit: 0n },
        l2_gas: { max_amount: 0n, max_price_per_unit: 0n },
        l1_data_gas: { max_amount: 0n, max_price_per_unit: 0n },
      },
      tip: 0n,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      version: ETransactionVersion.V3,
      chainId: this.chainId,
    };
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    // Validate signature similar to how __execute__ does in the contract.
    // execute_view skips this since view functions don't have tx_info.
    await this.validateSignature(invocation);

    const result = await this.provider.callContract({
      contractAddress: invocation.contractAddress,
      entrypoint: "execute_view",
      calldata: invocation.calldata!,
    });

    // execute_view returns Span<ServerAction> which is serialized with its length prefix.
    // execute_actions also expects Span<ServerAction> with the length prefix, so we pass it through as-is.
    return { output: result, outputHash: undefined!, data: undefined! };
  }

  /**
   * Validates the signature by calling is_valid_signature on the user's account.
   * This mirrors what the contract's __execute__ does after execute_view.
   */
  private async validateSignature(invocation: ProofInvocation): Promise<void> {
    const signatureArray = signatureToArray(invocation.signature);
    if (signatureArray.length === 0) {
      // No signature to validate (e.g., mock invocation factory)
      return;
    }

    // Extract user address from calldata (first element in __execute__ calldata)
    const calldata = invocation.calldata as string[];
    const userAddress = num.toHex(calldata[0]);

    // Compute transaction hash using the same parameters as the signer
    // The signer wraps the call in getExecuteCalldata format
    const details = this.getDefaultDetails();
    const executeCalldata = transaction.getExecuteCalldata(
      [
        {
          contractAddress: invocation.contractAddress,
          entrypoint: "__execute__",
          calldata,
        },
      ],
      "1" // cairoVersion
    );
    const txHash = hash.calculateInvokeTransactionHash({
      senderAddress: userAddress,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      version: details.version as any,
      compiledCalldata: executeCalldata,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chainId: this.chainId as any,
      nonce: details.nonce!,
      accountDeploymentData: details.accountDeploymentData!,
      nonceDataAvailabilityMode: daToInt(details.nonceDataAvailabilityMode!),
      feeDataAvailabilityMode: daToInt(details.feeDataAvailabilityMode!),
      resourceBounds: details.resourceBounds!,
      tip: details.tip!,
      paymasterData: details.paymasterData!,
    });

    // Call is_valid_signature on user's account
    // Calldata format: [hash, signature_length, ...signature_elements]
    const isValidCalldata = [txHash, num.toHex(signatureArray.length), ...signatureArray];

    const result = await this.provider.callContract({
      contractAddress: userAddress,
      entrypoint: "is_valid_signature",
      calldata: isValidCalldata,
    });

    // Check result equals VALIDATED ('VALID' as felt252)
    if (result[0] !== VALIDATED) {
      throw new Error(`Signature validation failed: expected ${VALIDATED}, got ${result[0]}`);
    }
  }
}
