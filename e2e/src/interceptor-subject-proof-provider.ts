/**
 * A proving provider that resolves the screening subject with the proof interceptor's own
 * `getScreenedAddress`, rather than a second implementation of the pool's rule.
 *
 * The interceptor decides the subject for the real prover. It depends on the SDK, so the SDK cannot
 * depend on it — but this package depends on both, so a devnet suite can run the production rule
 * against a real pool. Signing stays here: in production the interceptor does not sign either, it
 * relays a signature from the screener, and on devnet the pool is deployed with the test screener's
 * public key.
 */

import type { BlockIdentifier, ProviderInterface, constants } from "starknet";
import {
  getScreenedAddress,
  type ScreenedAddressConfig,
} from "@starkware-libs/proof-interceptor/dist/screened-address.js";
import {
  parsePolicy,
  type OpenNoteScreeningPolicy,
} from "@starkware-libs/proof-interceptor/dist/screening-policy.js";
import type { ProveTxnV3 } from "@starkware-libs/proof-interceptor/dist/types.js";
import type {
  Proof,
  ProofInvocation,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  attestScreeningSubject,
  CallMockProofProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";

export type InterceptorSubjectConfig = ScreenedAddressConfig;

export class InterceptorSubjectProofProvider extends CallMockProofProvider {
  constructor(
    node: ProviderInterface,
    chainId: constants.StarknetChainId,
    private readonly screening: InterceptorSubjectConfig,
  ) {
    super(node, chainId);
  }

  async prove(
    invocation: ProofInvocation,
    blockIdentifier?: BlockIdentifier,
  ): Promise<Proof> {
    const proof = await super.prove(invocation, blockIdentifier);

    const screened = await getScreenedAddress(
      invocation as ProveTxnV3,
      this.screening,
      {
        getPolicy: (depositor) => this.readPolicy(depositor, blockIdentifier),
      },
    );

    if (screened.kind === "none") return proof;
    if (screened.kind !== "one") {
      throw new Error(
        `the interceptor put up no screenable address for this transaction: ${screened.kind}`,
      );
    }

    return attestScreeningSubject(
      this.node,
      proof,
      screened.address,
      blockIdentifier,
    );
  }

  /**
   * The pool's open-note screening policy for `depositor`, or `null` when the read fails.
   *
   * Read at the block being proven and never cached, where the interceptor's own client caches at
   * `latest` for a TTL: a suite that sets a policy and immediately proves against it must see the
   * policy that block holds.
   */
  private async readPolicy(
    depositor: string,
    blockIdentifier?: BlockIdentifier,
  ): Promise<OpenNoteScreeningPolicy | null> {
    try {
      const felts = await this.node.callContract(
        {
          contractAddress: this.screening.poolAddress,
          entrypoint: "get_open_note_screening_policy",
          calldata: [depositor],
        },
        blockIdentifier ?? "latest",
      );
      return parsePolicy(felts);
    } catch {
      return null;
    }
  }
}
