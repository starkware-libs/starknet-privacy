import { constants, num, type CallDetails, type RpcProvider } from "starknet";
import {
  createPrivateTransfers,
  predictReceivedEncNote,
  type InvokeCalldataBuilderArgs,
} from "starknet-sdk";

import type {
  BuildProofParams,
  Felt,
  POTCService,
  POTCServiceConfig,
  Proof,
  SettlementReceipt,
  TxHash,
} from "./types.js";

function toHex(felt: Felt): string {
  return num.toHex(felt);
}

// Sequencer requires proof block <= latest - STORED_BLOCK_HASH_BUFFER (10).
// Mirror useTransactions.PROVING_BLOCK_DEPTH (9) so proving + tx submission
// stays within the acceptance window.
const PROVING_BLOCK_DEPTH = 9;

class POTCServiceImpl implements POTCService {
  private readonly provider: RpcProvider;

  constructor(private readonly config: POTCServiceConfig) {
    // Account extends RpcProvider in starknet.js v10.
    this.provider = config.provider ?? (config.account as unknown as RpcProvider);
  }

  async buildProof(params: BuildProofParams): Promise<Proof> {
    const transfers = createPrivateTransfers({
      account: this.config.account,
      viewingKeyProvider: { getViewingKey: async () => this.config.viewingKey },
      provingProvider: {
        url: this.config.proverUrl,
        chainId: constants.StarknetChainId.SN_SEPOLIA,
      },
      discoveryProvider: { url: this.config.discoveryUrl },
      poolContractAddress: toHex(this.config.poolAddress),
    });

    const execOpts = {
      autoDiscover: { notes: "refresh" as const, channels: "refresh" as const },
      autoSelectNotes: "naive" as const,
      autoSetup: true,
    };

    // Pick a proving block old enough that the sequencer still accepts it
    // when the tx lands. Without this we'd default to "latest", and by the
    // time `estimateFee` runs the proof block is < latest-10 → rejected.
    const provingBlockId = (await this.provider.getBlockNumber()) - PROVING_BLOCK_DEPTH;

    // Discover the incoming channel from the counterparty so we can predict the
    // (note_id, packed_value) their `transfer(askToken, askAmount)` will emit.
    // The counterparty uses salt = trade_id (same as us), so the prediction is
    // exact and the helper contract can pin the trade to the agreed token+amount.
    // The IndexerDiscoveryProvider returns a `cursor` field that the public
    // interface doesn't declare; cast through `unknown` to access it.
    const discovery = (await transfers.discoverNotes({
      tokens: [params.askToken],
    })) as unknown as {
      cursor?: {
        incomingChannels: {
          get(sender: bigint): {
            channelKey: bigint;
            noteIndexes: { get(token: bigint): number | undefined };
          } | undefined;
        };
      };
    };
    const counterpartyChannel = discovery.cursor?.incomingChannels.get(
      params.counterparty,
    );
    if (!counterpartyChannel) {
      throw new Error(
        "No incoming channel from counterparty — they must open a channel to you " +
          "(any prior transfer or setup) before this trade can bind the ask leg.",
      );
    }
    const askNoteIndex = counterpartyChannel.noteIndexes.get(params.askToken) ?? 0;
    const expected = predictReceivedEncNote({
      channelKey: counterpartyChannel.channelKey,
      token: params.askToken,
      index: askNoteIndex,
      salt: params.tradeId,
      amount: params.askAmount,
    });

    // InvokeExternal → OtcSettlement.privacy_invoke(trade_id, EncNoteCreated).
    // The pool calls it during apply_stored_actions and the helper asserts that
    // ServerAction::EmitEncNoteCreated(expected) appears in one of the two legs.
    // Since note_ids include channel_key (party-specific) and token, the only
    // place this matches is the counterparty's transfer to us with salt=trade_id.
    const buildInvoke = (_args: InvokeCalldataBuilderArgs): CallDetails => ({
      contractAddress: toHex(this.config.executorAddress),
      calldata: [
        toHex(params.tradeId),
        toHex(expected.note_id),
        toHex(expected.packed_value),
      ],
    });

    const invocation = await transfers
      .build(execOpts)
      .surplusTo(this.config.account.address)
      .with(toHex(params.offerToken), (t) =>
        t.transfer({
          recipient: toHex(params.counterparty),
          amount: params.offerAmount,
          salt: params.tradeId,
        }),
      )
      .invoke(buildInvoke)
      .createProofInvocation({ provingBlockId });

    return transfers.buildStoreCallFromInvocation(invocation, provingBlockId);
  }

  async submitProof(tradeId: Felt, proof: Proof): Promise<TxHash> {
    const { callAndProof } = proof;
    const proofExtras =
      callAndProof.proof.proofFacts?.length > 0
        ? { proof: callAndProof.proof.data, proofFacts: callAndProof.proof.proofFacts }
        : {};

    // The serialized `Span<ServerAction>` is exactly the calldata that
    // `pool.store_actions` would consume. We re-route it through
    // `OtcSettlement.join_trade(trade_id, actions)`. The Span is already
    // length-prefixed by the SDK, so passing `[trade_id, ...actions]` matches
    // the executor's ABI directly. The executor auto-detects whether this is
    // the first or second leg via its internal `trade_hashes[trade_id]`.
    const actionsCalldata = callAndProof.call.calldata as string[];

    const { transaction_hash } = await this.config.account.execute(
      [
        {
          contractAddress: toHex(this.config.executorAddress),
          entrypoint: "join_trade",
          calldata: [toHex(tradeId), ...actionsCalldata],
        },
      ],
      { tip: 0n, ...proofExtras },
    );

    return transaction_hash;
  }

  async awaitSettled(tradeId: Felt, signal?: AbortSignal): Promise<SettlementReceipt> {
    // The contract has no `TradeSettled` event yet; we just read the current
    // block number. For a real poller, the contract should emit when
    // `trade_hashes[trade_id]` resets — until then, callers should rely on
    // the submitProof tx receipt for finality.
    if (signal?.aborted) throw new DOMException("awaitSettled aborted", "AbortError");
    const blockNumber = await this.provider.getBlockNumber();
    return { tradeId, settledTxHash: "", settledBlock: blockNumber };
  }
}

export function createPOTCService(config: POTCServiceConfig): POTCService {
  return new POTCServiceImpl(config);
}
