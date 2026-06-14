/**
 * A mock proving provider that also fabricates a screening attestation for
 * regular-pool deposits, so the devnet suite can exercise the screening-capable
 * pool's deposit path end to end.
 *
 * The real proving service screens a deposit's depositor and relays the
 * screener's signature in the proof's `additional_data`; the screening-capable
 * contract rejects a deposit whose attestation is missing or invalid. This
 * provider mirrors that: when the proven actions contain a `Deposit`, it signs
 * an attestation over the depositor with the canonical test screener key (whose
 * public key the pool is deployed with) and attaches it. Non-deposit actions
 * carry no attestation — the contract requires `Option::None` for those.
 */

import { CallData, num, type BlockIdentifier } from "starknet";
import { PrivacyPoolABI } from "../internal/abi.js";
import type { Proof, ProofInvocation } from "../interfaces.js";
import { extractExecuteViewCalldata } from "../internal/proof-invocation-factory.js";
import { CallMockProofProvider } from "./mock-proving.js";
import { signScreeningAttestation, SCREENING_SIGNER_PRIVATE_KEY } from "./screening-signer.js";

const CLIENT_ACTIONS_TYPE = "core::array::Span::<privacy::actions::ClientAction>" as const;

export class ScreeningCallMockProofProvider extends CallMockProofProvider {
  private readonly actionsDecoder = new CallData(PrivacyPoolABI);

  async prove(invocation: ProofInvocation, blockIdentifier?: BlockIdentifier): Promise<Proof> {
    const proof = await super.prove(invocation, blockIdentifier);

    const depositor = this.depositorToScreen(invocation);
    if (depositor === undefined) return proof;

    // Sign over the chain id the contract actually verifies against
    // (get_tx_info().chain_id), queried from the chain rather than assumed, and
    // an issued_at <= the block timestamp the contract reads (else
    // SCREENING_FUTURE_DATED) — use the chain's own clock, not the host's.
    const chainId = await this.provider.getChainId();
    const block = await this.provider.getBlock(blockIdentifier ?? "latest");
    const signature = signScreeningAttestation(
      SCREENING_SIGNER_PRIVATE_KEY,
      BigInt(chainId),
      BigInt(depositor),
      Number(block.timestamp)
    );
    return { ...proof, additionalData: { signature } };
  }

  /**
   * The depositor to attest, or `undefined` when the invocation carries no
   * regular-pool deposit. Inner calldata is `[user_addr, user_private_key,
   * ...client actions]`; the depositor is `user_addr`, matching the
   * `TransferFrom.from_addr` a self-funded deposit proves on-chain.
   */
  private depositorToScreen(invocation: ProofInvocation): string | undefined {
    const innerCalldata = extractExecuteViewCalldata(invocation.calldata as string[]);
    if (innerCalldata.length < 3) return undefined;
    try {
      const decoded = this.actionsDecoder.decodeParameters(
        CLIENT_ACTIONS_TYPE,
        innerCalldata.slice(2)
      ) as Array<{ activeVariant: () => string }>;
      const hasDeposit = decoded.some((action) => action.activeVariant() === "Deposit");
      return hasDeposit ? num.toHex(innerCalldata[0]) : undefined;
    } catch {
      return undefined;
    }
  }
}
