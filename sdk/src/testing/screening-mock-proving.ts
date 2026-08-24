/**
 * A mock proving provider that also fabricates a screening attestation for the one address the pool
 * requires, so the devnet suites can exercise the screening-capable pool end to end.
 *
 * The real proving service resolves that address, screens it and relays the screener's signature in
 * the proof's `additional_data`; the pool rejects a deposit whose attestation is missing or invalid,
 * and equally rejects one it has no subject for. This provider mirrors the pool's own rule: it signs
 * over the address the pool will ask for with the canonical test screener key (whose public key the
 * pool is deployed with), and attaches nothing when the pool asks for nobody.
 *
 * The policy is read from the pool at prove time, so a suite that lists a target `Exempt` gets no
 * attestation and one that lists it `Delegated` gets its shadow account attested, with no provider
 * configuration either way. The read is not defended: a pool without the policy entry point fails
 * loudly here rather than silently dropping a suite's screening coverage.
 */

import { CairoCustomEnum, CallData, num, type BlockIdentifier } from "starknet";
import { PrivacyPoolABI } from "../internal/abi.js";
import type { Proof, ProofInvocation } from "../interfaces.js";
import { extractExecuteViewCalldata } from "../internal/proof-invocation-factory.js";
import { CallMockProofProvider } from "../internal/mock-proving.js";
import {
  shadowAccountAddress,
  shadowAccountCommitment,
  shadowAccountPartialCommitment,
} from "../internal/shadow-account-address.js";
import { signScreeningAttestation, SCREENING_SIGNER_PRIVATE_KEY } from "./screening-signer.js";

const CLIENT_ACTIONS_TYPE = "core::array::Span::<privacy::actions::ClientAction>" as const;
const POLICY_TYPE = "privacy::objects::OpenNoteScreeningPolicy" as const;

const poolCallData = new CallData(PrivacyPoolABI);

/** The pool's open-note screening policies, in the order its Cairo enum declares them. */
export type OpenNoteScreeningPolicy = "Required" | "Exempt" | "Delegated";

/** Answers the open-note screening policy the pool at `poolAddress` holds for `depositor`. */
export type OpenNotePolicyReader = (
  poolAddress: string,
  depositor: string
) => Promise<OpenNoteScreeningPolicy>;

/** The Invoke target funding a transaction's open notes, and the action driving it. */
interface OpenNoteDepositor {
  address: string;
  action: CairoCustomEnum;
  isComputeAndInvoke: boolean;
}

/** A pool call's inner calldata: `[user_addr, user_private_key, ...client actions]`. */
interface PoolCall {
  poolAddress: string;
  userAddress: string;
  viewingKey: bigint;
  actions: CairoCustomEnum[];
}

/**
 * The one address the pool requires an attestation over for `calldata`, or `undefined` when it
 * requires none. Three kinds reach it, at most one per transaction:
 *
 * - a `Deposit`'s own depositor, `user_addr`, which no policy waives;
 * - an Invoke target that funds open notes and whose open-note policy is `Required`;
 * - the shadow account an interaction runs through, when that target's policy is `Delegated`.
 *
 * Throws when the transaction puts up more than one, which is the pool's
 * `MULTIPLE_SCREENING_SUBJECTS` revert reached before the transaction is sent: a deposit combined
 * with a screened invoke cannot be proven, whichever address were attested.
 */
export async function screeningSubjectOf(
  calldata: string[],
  policyFor: OpenNotePolicyReader
): Promise<string | undefined> {
  const poolCall = decodePoolCall(calldata);
  if (poolCall === undefined) return undefined;

  const subjects = new Set<string>();

  // `user_addr` matches the `TransferFrom.from_addr` a self-funded deposit proves on-chain.
  if (poolCall.actions.some((action) => action.activeVariant() === "Deposit")) {
    subjects.add(poolCall.userAddress);
  }

  const depositor = openNoteDepositor(poolCall.actions);
  if (depositor !== undefined) {
    const policy = await policyFor(poolCall.poolAddress, depositor.address);
    if (policy === "Required") {
      subjects.add(depositor.address);
    } else if (policy === "Delegated" && depositor.isComputeAndInvoke) {
      // Only the anonymizer is listed `Delegated`, and it puts up the shadow account its
      // interaction runs through. A plain Invoke carries no interaction, so it puts up nobody.
      subjects.add(shadowAccountOf(poolCall, depositor));
    }
  }

  if (subjects.size > 1) {
    throw new Error(
      "the pool screens one address per transaction, and this one puts up " +
        `${subjects.size}: prove the deposit and the screened invoke separately`
    );
  }
  const [subject] = subjects;
  return subject;
}

export class ScreeningCallMockProofProvider extends CallMockProofProvider {
  async prove(invocation: ProofInvocation, blockIdentifier?: BlockIdentifier): Promise<Proof> {
    const proof = await super.prove(invocation, blockIdentifier);

    const subject = await screeningSubjectOf(
      invocation.calldata as string[],
      (poolAddress, depositor) => this.openNotePolicy(poolAddress, depositor, blockIdentifier)
    );
    if (subject === undefined) return proof;

    // Sign over the chain id the contract actually verifies against
    // (get_tx_info().chain_id), queried from the chain rather than assumed, and
    // an issued_at <= the block timestamp the contract reads (else
    // SCREENING_FUTURE_DATED) — use the chain's own clock, not the host's.
    const chainId = await this.node.getChainId();
    const block = await this.node.getBlock(blockIdentifier ?? "latest");
    const signature = signScreeningAttestation(
      SCREENING_SIGNER_PRIVATE_KEY,
      BigInt(chainId),
      BigInt(subject),
      Number(block.timestamp)
    );
    return { ...proof, additionalData: { signature } };
  }

  /** The pool's open-note screening policy for `depositor`, decoded through the committed ABI. */
  private async openNotePolicy(
    poolAddress: string,
    depositor: string,
    blockIdentifier?: BlockIdentifier
  ): Promise<OpenNoteScreeningPolicy> {
    const felts = await this.node.callContract(
      {
        contractAddress: poolAddress,
        entrypoint: "get_open_note_screening_policy",
        calldata: [depositor],
      },
      blockIdentifier ?? "latest"
    );
    const decoded = poolCallData.decodeParameters(
      POLICY_TYPE,
      felts as string[]
    ) as CairoCustomEnum;
    return decoded.activeVariant() as OpenNoteScreeningPolicy;
  }
}

/**
 * The shadow account `depositor`'s interaction runs through, derived from the transaction's own
 * felts. The anonymizer salts the deploy by the identity commitment, so the address resolves before
 * the account exists.
 */
function shadowAccountOf(poolCall: PoolCall, depositor: OpenNoteDepositor): string {
  const { compute_additional_data: computeData } = depositor.action.unwrap() as {
    compute_additional_data: bigint[];
  };
  const [dappName, nonce] = computeData;
  const anonymizer = BigInt(depositor.address);
  const commitment = shadowAccountCommitment(
    shadowAccountPartialCommitment(
      BigInt(poolCall.userAddress),
      poolCall.viewingKey,
      anonymizer,
      dappName
    ),
    nonce
  );
  return num.toHex(shadowAccountAddress(commitment, anonymizer));
}

/**
 * The Invoke target funding this transaction's open notes, or `undefined` when it creates none. An
 * open note must be funded within the transaction that creates it, so a `CreateOpenNote` is what
 * makes an Invoke the transaction's open-note depositor.
 */
function openNoteDepositor(actions: CairoCustomEnum[]): OpenNoteDepositor | undefined {
  if (!actions.some((action) => action.activeVariant() === "CreateOpenNote")) {
    return undefined;
  }
  for (const action of actions) {
    const variant = action.activeVariant();
    if (variant !== "InvokeExternal" && variant !== "ComputeAndInvoke") continue;
    const { contract_address: contractAddress } = action.unwrap() as {
      contract_address: bigint;
    };
    return {
      address: num.toHex(contractAddress),
      action,
      isComputeAndInvoke: variant === "ComputeAndInvoke",
    };
  }
  return undefined;
}

/**
 * The invocation's pool call, or `undefined` when its calldata is not one. Account execute calldata
 * is `[call_count, contract_address, selector, inner_len, ...inner]`, so the pool is the call's own
 * target rather than something this provider has to be told.
 */
function decodePoolCall(calldata: string[]): PoolCall | undefined {
  if (calldata.length < 5) return undefined;
  const innerCalldata = extractExecuteViewCalldata(calldata);
  if (innerCalldata.length < 3) return undefined;
  try {
    return {
      poolAddress: num.toHex(calldata[1]),
      userAddress: num.toHex(innerCalldata[0]),
      viewingKey: BigInt(innerCalldata[1]),
      actions: poolCallData.decodeParameters(
        CLIENT_ACTIONS_TYPE,
        innerCalldata.slice(2)
      ) as CairoCustomEnum[],
    };
  } catch {
    return undefined;
  }
}
