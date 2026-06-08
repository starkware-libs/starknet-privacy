// State machine driving the "Review withdraw" CTA. Lifecycle:
//   idle → quoting → composing → awaiting-signature → sent | error
// `submit()` triggers the full pipeline; `reset()` returns to idle.
import { useCallback, useRef, useState } from "react";
import { OneClickService, QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { Witness, type Note } from "starknet-sdk";
import type { Token } from "../types";
import {
  ANONYMIZER_ADDRESS,
  POOL_CONTRACT_ADDRESS,
  RECEIVER_CLASS_HASH,
  STRK_TOKEN_ADDRESS,
} from "../lib/chain";
import { findAssetByToken, toBaseUnits } from "../lib/oneclick";
import { refundMailbox } from "../lib/anonymizer";
import { useWallet } from "./useWallet";
import { buildPoolTx1 } from "../lib/pool-builder";

export type WithdrawSubmitState =
  | { kind: "idle" }
  | { kind: "quoting"; step: "fetching-deposit-address" }
  | { kind: "composing" }
  | { kind: "awaiting-signature" }
  | { kind: "sent"; txHash: string }
  | { kind: "error"; message: string };

export interface UseWithdrawSubmitParams {
  fromToken: Token;
  toToken: Token;
  fromAmount: number;
  destinationAddress: string;
  slippageBps: number;
  swapId: string;
}

export interface UseWithdrawSubmitResult {
  state: WithdrawSubmitState;
  submit: () => Promise<void>;
  reset: () => void;
}

export function useWithdrawSubmit(
  params: UseWithdrawSubmitParams,
): UseWithdrawSubmitResult {
  const { status: walletStatus, wallet, identity } = useWallet();
  const [state, setState] = useState<WithdrawSubmitState>({ kind: "idle" });
  // Guard against concurrent submits if a user double-clicks.
  const inflightRef = useRef(false);

  const reset = useCallback(() => {
    inflightRef.current = false;
    setState({ kind: "idle" });
  }, []);

  const submit = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;

    try {
      if (walletStatus.kind !== "connected") {
        throw new SubmitError("Connect your Starknet wallet first.");
      }
      if (identity.kind !== "ready") {
        throw new SubmitError("Derive your shielded identity before withdrawing.");
      }
      // starknetkit's wallet object carries the connected `.account` (an
      // `AccountInterface`). We grabbed the same in `useWallet`, but it isn't
      // exposed on the context; rip it back off the underlying wallet object.
      const accountField = (wallet as unknown as { account?: unknown })?.account;
      const account =
        accountField && typeof accountField === "object" ? (accountField as never) : null;
      if (!account) {
        throw new SubmitError("Wallet did not expose an account interface.");
      }

      setState({ kind: "quoting", step: "fetching-deposit-address" });

      const depositAddress = await fetchRealDepositAddress({
        from: params.fromToken,
        to: params.toToken,
        amountIn: toBaseUnits(params.fromAmount, params.fromToken.decimals),
        slippageBps: params.slippageBps,
        recipient: params.destinationAddress,
        refundTo: refundMailbox(
          {
            anonymizerAddress: ANONYMIZER_ADDRESS,
            receiverClassHash: RECEIVER_CLASS_HASH,
          },
          params.swapId,
        ),
      });

      setState({ kind: "composing" });

      const inAmount = toBaseUnits(params.fromAmount, params.fromToken.decimals);
      // We don't have real shielded notes wired yet (the UI's
      // `shieldedBalance` is a mock). For the demoable wallet-pop path, we
      // synthesize an input-note stub matching the amount; the prover will
      // still build a coherent invocation. When `discoverNotes()` lands in
      // the UI, drop this stub and pass the real `Note`.
      const inputNote: Note = synthesizeInputNoteStub(inAmount);

      const tx1 = await buildPoolTx1({
        account,
        viewingKey: identity.identity.privateKey,
        inputNote,
        inAmount,
        swapId: params.swapId,
        depositAddress,
        anonymizerAddress: ANONYMIZER_ADDRESS,
        providers: { poolContractAddress: POOL_CONTRACT_ADDRESS },
      });

      setState({ kind: "awaiting-signature" });

      // `account.execute` pops the wallet. The starknet@8 AccountInterface
      // accepts an array of `Call` and optional details (tip, proof, etc).
      const executeOpts = {
        tip: tx1.executeOpts.tip,
        ...(tx1.executeOpts.proof ? { proof: tx1.executeOpts.proof } : {}),
        ...(tx1.executeOpts.proofFacts
          ? { proofFacts: tx1.executeOpts.proofFacts }
          : {}),
      };
      const accountIface = account as unknown as {
        execute: (
          calls: typeof tx1.calls,
          opts: typeof executeOpts,
        ) => Promise<{ transaction_hash: string }>;
      };
      const submitted = await accountIface.execute(tx1.calls, executeOpts);

      setState({ kind: "sent", txHash: submitted.transaction_hash });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message });
    } finally {
      inflightRef.current = false;
    }
  }, [params, walletStatus, wallet, identity]);

  return { state, submit, reset };
}

class SubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmitError";
  }
}

/**
 * Re-request the 1Click quote with `dry: false` to get an actual deposit
 * address. The anonymizer needs to know where to forward the STRK after
 * `Withdraw` lands, so we can't proceed with the dry-run preview address.
 */
async function fetchRealDepositAddress(args: {
  from: Token;
  to: Token;
  amountIn: bigint;
  slippageBps: number;
  recipient: string;
  refundTo: string;
}): Promise<string> {
  const [fromAsset, toAsset] = await Promise.all([
    findAssetByToken(args.from),
    findAssetByToken(args.to),
  ]);
  if (!fromAsset || !toAsset) {
    throw new SubmitError(
      `Asset pair ${args.from.symbol}→${args.to.symbol} not indexed by 1Click.`,
    );
  }
  const request: QuoteRequest = {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: args.slippageBps,
    originAsset: fromAsset.assetId,
    destinationAsset: toAsset.assetId,
    amount: args.amountIn.toString(),
    refundTo: args.refundTo,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: args.recipient,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const response = await OneClickService.getQuote(request);
  const depositAddress = response.quote.depositAddress;
  if (!depositAddress) {
    throw new SubmitError("1Click did not return a deposit address.");
  }
  return depositAddress;
}

/**
 * Placeholder note used while discoverNotes() isn't wired into the UI yet.
 * The shape matches the SDK's `Note` interface so the compiler accepts it;
 * the prover will still refuse to sign over an invalid witness on a real run.
 * Demo-only: swap for `(await transfers.discoverNotes(...)).notes.get(STRK)`
 * once that flow exists.
 */
function synthesizeInputNoteStub(amount: bigint): Note {
  // `Witness` ctor: (channelKey, nonce, r). All-zero is structurally valid;
  // the prover will reject it on a real run, which is the expected demo path.
  return {
    id: amount, // unique-ish; real id is `compute_note_id(channelKey, token, index)`
    amount,
    witness: new Witness(0n, 0, 0n),
    sender: STRK_TOKEN_ADDRESS,
  };
}

