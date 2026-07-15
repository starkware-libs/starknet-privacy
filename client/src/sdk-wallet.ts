import type { Call, STRK20_CALL_AND_PROOF, STRK20_PROOF } from "starknet";
import type { StarknetAddress } from "@starkware-libs/starknet-privacy-sdk";
import { toStarknetCall } from "./calls.js";
import { toPaymasterCall } from "./paymaster.js";
import type { Paymaster } from "./paymaster.js";
import type { PrivacyWallet, Strk20Action, Strk20Prover } from "./interfaces.js";

/**
 * Dependencies for an {@link SdkWallet}: the {@link Strk20Prover} that proves actions (and owns the
 * viewing key), the {@link Paymaster} that sponsors + broadcasts the fee, and the privacy pool
 * address the paymaster applies actions against.
 */
export interface SdkWalletConfig {
  prover: Strk20Prover;
  paymaster: Paymaster;
  poolContractAddress: StarknetAddress;
}

/**
 * The non-native {@link PrivacyWallet} for wallets that are not get-starknet v6 strk20 wallets (EVM /
 * legacy-SN, via a CallSet signer inside the prover). It proves through the injected prover and
 * broadcasts through the paymaster so the user never needs to hold the fee token.
 *
 * `strk20InvokeTransaction` runs the private (`apply_action`) flow: quote the fee, fold it in as a
 * `withdraw` so it is covered by the proof, prove, then hand the proven call to the paymaster. This
 * covers submissions that spend the user's existing notes (withdraw / transfer / invoke).
 *
 * A deposit additionally needs an ERC-20 `approve`, which must run as the user (the token owner) —
 * but under `apply_action` the executing account is the paymaster, not the user, so the `approve`
 * cannot ride along here. That case is the "regular" flow (`invoke_and_apply_action`, which carries a
 * user-signed `approve` invoke) and is not implemented yet, so `executeWithProof` and
 * `estimateInvokeFee` — the client's surrounding-calls / fee-estimate paths — reject for now.
 */
export class SdkWallet implements PrivacyWallet {
  constructor(private readonly config: SdkWalletConfig) {}

  partialCommitment(dappName: string): Promise<bigint> {
    return this.config.prover.partialCommitment(dappName);
  }

  strk20PrepareInvoke(actions: Strk20Action[], simulate?: boolean): Promise<STRK20_CALL_AND_PROOF> {
    return this.config.prover.prove(actions, simulate);
  }

  async strk20InvokeTransaction(actions: Strk20Action[]): Promise<{ transaction_hash: string }> {
    const { prover, paymaster, poolContractAddress } = this.config;
    const poolAddress = String(poolContractAddress);
    // Quote the fee, fold it in as a withdraw so the proof covers it, prove, then let the paymaster
    // broadcast. Fee mode is the paymaster's own config; here we only add the quoted withdrawal.
    const { feeAction } = await paymaster.buildTransaction({ kind: "applyAction", poolAddress });
    const feeWithdraw: Strk20Action = {
      type: "withdraw",
      token: feeAction.token,
      amount: feeAction.amount,
      recipient: feeAction.recipient,
    };
    const { call, proof } = await prover.prove([...actions, feeWithdraw]);
    const { transactionHash } = await paymaster.executeTransaction({
      kind: "applyAction",
      applyActionsCall: toPaymasterCall(toStarknetCall(call)),
      proof: proof.data,
      proofFacts: proof.proof_facts,
    });
    return { transaction_hash: transactionHash };
  }

  executeWithProof(_calls: Call[], _proof?: STRK20_PROOF): Promise<{ transaction_hash: string }> {
    return Promise.reject(
      new Error(
        "SdkWallet: submitting with surrounding calls (the regular deposit/approve flow) is not yet " +
          "implemented; use strk20InvokeTransaction for private submissions"
      )
    );
  }

  estimateInvokeFee(): Promise<never> {
    return Promise.reject(
      new Error("SdkWallet: fee estimation via the paymaster is not yet implemented")
    );
  }
}
