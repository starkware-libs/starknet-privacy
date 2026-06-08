// Composes the privacy-pool "Tx 1" for the off-ramp (withdraw) flow described
// in `docs/near-intents-integration-plan.md` and the anonymizer README. Five
// client actions, in order:
//
//   1. UseNote(STRK note)                 — consume the user's shielded STRK
//   2. CreateOpenNote(STRK, N_out)        — phantom; off-ramp never fills it
//   3. CreateOpenNote(STRK, N_refund)     — filled by `recover()` on refund
//   4. Withdraw(STRK → anonymizer)        — public STRK lands at the anonymizer
//   5. InvokeExternal(anonymizer.privacy_invoke(...))
//
// We drive the SDK's fluent builder (`build().with(STRK, …).invoke(…)`) so the
// action shape, on-chain encoding, and pool invariants match the production
// path. The single resulting `apply_actions` call is what `account.execute(…)`
// pops in Argent X.
import type { Account, AccountInterface, Call } from "starknet";
import {
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  Open,
  ProvingServiceProofProvider,
  type Note,
  type ExecuteResult,
  type PrivateTransfersInterface,
} from "starknet-sdk";
import { constants } from "starknet";
import {
  ANONYMIZER_ADDRESS,
  CHAIN,
  DISCOVERY_SERVICE_URL,
  POOL_CONTRACT_ADDRESS,
  PROVING_SERVICE_URL,
  STRK_TOKEN_ADDRESS,
} from "./chain";
import { privacyInvokeCalldata } from "./anonymizer";

export interface BuildPoolTx1Args {
  /** Wallet account from starknetkit (we treat it as a starknet.js Account). */
  account: AccountInterface;
  /** Viewing key derived from the wallet's signature (see `lib/identity.ts`). */
  viewingKey: bigint;
  /** Shielded input note to consume. */
  inputNote: Note;
  /** Base-unit input amount; must match `inputNote.amount` exactly. */
  inAmount: bigint;
  /** Per-swap id (Pedersen of address+nonce). See `anonymizer.ts:newSwapId`. */
  swapId: string;
  /** NEAR Intents deposit address returned by `OneClickService.getQuote({ dry: false })`. */
  depositAddress: string;
  /** Anonymizer contract address (default from `chain.ts`). */
  anonymizerAddress?: string;
  /** Provider/discovery overrides (used by tests). */
  providers?: {
    proofProviderUrl?: string;
    discoveryProviderUrl?: string;
    poolContractAddress?: string;
  };
}

export interface PoolTx1 {
  /** Final invocation to feed to `account.execute(...)`. Pops the wallet. */
  calls: Call[];
  /** Extra params passed alongside `calls` (proof facts, tip, etc). */
  executeOpts: { tip: bigint; proof?: string; proofFacts?: string[] };
  /** Full `ExecuteResult` from the SDK — exposes registry + warnings. */
  raw: ExecuteResult;
}

/**
 * Build the privacy-pool Tx 1 invocation for an off-ramp withdraw.
 *
 * Triggers the prover + discovery service over the network (see
 * `PROVING_SERVICE_URL` / `DISCOVERY_SERVICE_URL` in `chain.ts`). The returned
 * `calls` array is the single `apply_actions` call signed by the user's wallet
 * — the proven server actions are embedded in its calldata.
 */
export async function buildPoolTx1(args: BuildPoolTx1Args): Promise<PoolTx1> {
  const anonymizer = args.anonymizerAddress ?? ANONYMIZER_ADDRESS;
  const poolAddress = args.providers?.poolContractAddress ?? POOL_CONTRACT_ADDRESS;
  const proverUrl = args.providers?.proofProviderUrl ?? PROVING_SERVICE_URL;
  const discoveryUrl = args.providers?.discoveryProviderUrl ?? DISCOVERY_SERVICE_URL;

  // SDK's Account type is the starknet@10 concrete `Account` class; our wallet
  // exposes `AccountInterface` from starknet@8 (starknetkit's peer). The two
  // are structurally compatible for the methods the SDK actually invokes
  // (signMessage, execute). Cast through `unknown` to bridge.
  const transfers = createSdkTransfers({
    account: args.account as unknown as Account,
    viewingKey: args.viewingKey,
    poolContractAddress: poolAddress,
    proverUrl,
    discoveryUrl,
  });

  return runBuilder(transfers, {
    inputNote: args.inputNote,
    inAmount: args.inAmount,
    swapId: args.swapId,
    depositAddress: args.depositAddress,
    anonymizerAddress: anonymizer,
  });
}

/**
 * Internal seam — tests inject a mock `PrivateTransfersInterface` here without
 * going through `createPrivateTransfers` (which would need a live prover).
 */
export async function runBuilder(
  transfers: PrivateTransfersInterface,
  args: {
    inputNote: Note;
    inAmount: bigint;
    swapId: string;
    depositAddress: string;
    anonymizerAddress: string;
  },
): Promise<PoolTx1> {
  // The SDK's `transfer({ recipient, amount: Open })` emits a CreateNoteAction
  // with the `Open` marker, which the compiler serializes as CreateOpenNote on
  // the wire. We recover the SDK-assigned note IDs inside `.invoke(...)`.
  const result = await transfers
    .build()
    .with(STRK_TOKEN_ADDRESS, (t) => {
      t.inputs(args.inputNote)
        // CreateOpenNote(N_out) — phantom; never filled on off-ramp success.
        .transfer({ recipient: args.anonymizerAddress, amount: Open })
        // CreateOpenNote(N_refund) — filled by recover() if 1Click refunds.
        .transfer({ recipient: args.anonymizerAddress, amount: Open })
        // Withdraw(STRK, to=anonymizer, amount=inAmount).
        .withdraw({ recipient: args.anonymizerAddress, amount: args.inAmount });
    })
    .invoke(({ openNotes, withdrawals }) => {
      // The compiler emits open notes in declaration order. The first is N_out,
      // the second is N_refund — both bound to the anonymizer via channel_key.
      const noteOut = openNotes[0];
      const noteRefund = openNotes[1];
      const withdrawal = withdrawals[0];
      if (!noteOut || !noteRefund || !withdrawal) {
        throw new PoolBuilderError(
          "Compiler returned an unexpected action set; aborting tx composition.",
        );
      }
      return {
        contractAddress: args.anonymizerAddress,
        // Encoded by `privacyInvokeCalldata` to mirror the Cairo
        // `privacy_invoke(...)` selector layout (see anonymizer.ts).
        calldata: privacyInvokeCalldata({
          swapId: args.swapId,
          assetIn: STRK_TOKEN_ADDRESS,
          inAmount: args.inAmount,
          // Phantom asset_out for off-ramp; the anonymizer ignores it on the
          // success path (NEAR Intents pays the user off-chain).
          assetOut: STRK_TOKEN_ADDRESS,
          noteIdOut: toFeltString(noteOut.noteId),
          refundNoteId: toFeltString(noteRefund.noteId),
          depositAddress: args.depositAddress,
        }),
      };
    })
    .execute();

  // Translate SDK's call (whose type pins to starknet@10's `Call`) into the
  // starknet@8 `Call` our wallet path expects. The runtime shape is identical.
  const call = result.callAndProof.call as unknown as Call;
  const proofFacts = result.callAndProof.proof.proofFacts ?? [];
  return {
    calls: [call],
    executeOpts: {
      tip: 0n,
      proof: result.callAndProof.proof.data || undefined,
      proofFacts: proofFacts.length > 0 ? proofFacts : undefined,
    },
    raw: result,
  };
}

function toFeltString(value: bigint | number | string): string {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (typeof value === "number") return `0x${BigInt(value).toString(16)}`;
  if (value.startsWith("0x")) return value;
  return `0x${BigInt(value).toString(16)}`;
}

export class PoolBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolBuilderError";
  }
}

function createSdkTransfers(args: {
  account: Account;
  viewingKey: bigint;
  poolContractAddress: string;
  proverUrl: string;
  discoveryUrl: string;
}): PrivateTransfersInterface {
  // Pin chainId to SN_MAIN — the proving service is keyed on it. We also pass
  // `nodeUrl` so the prover can cache the pool nonce without extra round-trips.
  const provingProvider = new ProvingServiceProofProvider(
    args.proverUrl,
    constants.StarknetChainId.SN_MAIN,
    { nodeUrl: CHAIN.rpcUrl, poolAddress: args.poolContractAddress },
  );
  const discoveryProvider = new IndexerDiscoveryProvider(
    args.discoveryUrl,
    args.poolContractAddress,
  );
  return createPrivateTransfers({
    // SDK's Account is the starknet@10 concrete class; our wallet-resolved
    // account is starknet@8's Account (compatible at runtime). See
    // `buildPoolTx1` for why the cast is sound.
    account: args.account as unknown as Parameters<typeof createPrivateTransfers>[0]["account"],
    viewingKeyProvider: { getViewingKey: async () => args.viewingKey },
    provingProvider,
    discoveryProvider,
    poolContractAddress: args.poolContractAddress,
  });
}
