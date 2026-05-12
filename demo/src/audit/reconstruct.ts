/**
 * Compliance/tax audit trail reconstruction.
 *
 * Rebuilds the user's history of received notes from on-chain data using only
 * their viewing key — nothing is read from local storage. Each row links back
 * to its originating tx, and an opt-in `verifyAsOtc` per row inspects that tx
 * to confirm it routed through `OtcSettlement.join_trade` (and recovers the
 * trade_id from the calldata, even though our salt convention already encodes
 * it in the note itself).
 */

import { hash, num, type constants, type RpcProvider } from "starknet";
import {
  AddressMap,
  createPrivateTransfers,
  type Note,
} from "starknet-sdk";
import type { Account } from "starknet";

export type AuditEntry = {
  // Token contract address of the received note.
  token: string;
  // Cleartext amount the user received (raw units).
  amount: bigint;
  // Counterparty address (whoever sent this note).
  sender: string;
  // 120-bit note salt as encoded in the on-chain packed_value. For an OTC
  // trade the SDK uses `trade_id` as the salt, so this IS the trade_id for
  // those rows. For a normal transfer it's random.
  salt: bigint;
  // On-chain note id (selector lookup key for EncNoteCreated events).
  noteId: string;
  // Block in which the note was created (when known from the discovery cursor).
  blockNumber?: number;
};

export type OtcVerification = {
  // True if the tx that emitted this note's EncNoteCreated event included a
  // call to `OtcSettlement.join_trade`. False otherwise (a plain transfer).
  isOtc: boolean;
  // Tx that minted the note — always set, regardless of OTC status.
  txHash: string;
  // Block of that tx.
  blockNumber: number;
  // If OTC: the trade_id passed to join_trade. Matches `salt` on a well-formed
  // OTC entry; surfaced separately so the auditor can flag a mismatch.
  tradeId?: string;
};

export type ReconstructConfig = {
  account: Account;
  provider: RpcProvider;
  viewingKey: bigint;
  proverUrl: string;
  discoveryUrl: string;
  poolAddress: string;
  otcExecutorAddress: string;
  // Note: chainId is required by createPrivateTransfers' provingProvider field
  // even though we never prove here. Pass any valid chain id.
  chainId: constants.StarknetChainId;
};

const ENC_NOTE_CREATED_KEY = hash.getSelectorFromName("EncNoteCreated");
const JOIN_TRADE_SELECTOR = hash.getSelectorFromName("join_trade");

/**
 * Walk all incoming channels for the user and return one AuditEntry per
 * received note. Pure read — no on-chain writes. Uses the SDK's existing
 * indexer-backed discovery.
 */
export async function reconstructAuditTrail(
  config: ReconstructConfig,
): Promise<AuditEntry[]> {
  const transfers = createPrivateTransfers({
    account: config.account,
    viewingKeyProvider: { getViewingKey: async () => config.viewingKey },
    provingProvider: { url: config.proverUrl, chainId: config.chainId },
    discoveryProvider: { url: config.discoveryUrl },
    poolContractAddress: config.poolAddress,
  });

  const result = await transfers.discoverNotes({});
  const notes = result.notes as AddressMap<Note[]>;

  const entries: AuditEntry[] = [];
  for (const [token, noteList] of notes.entries()) {
    for (const note of noteList) {
      if (note.open) continue;
      entries.push({
        token: num.toHex(token),
        amount: BigInt(note.amount.toString()),
        sender: num.toHex(BigInt(note.sender.toString())),
        salt: note.witness.r,
        noteId: num.toHex(BigInt(note.id.toString())),
        blockNumber:
          typeof note.created === "number" ? note.created : undefined,
      });
    }
  }
  return entries;
}

/**
 * For a single entry, confirm it came from an OTC settlement and pull the
 * trade_id straight from the join_trade calldata.
 *
 * The lookup: `getEvents` for EncNoteCreated keyed by note_id (the event marks
 * note_id as `#[key]`), giving us tx_hash. Then `getTransactionByHash` →
 * inspect calldata for a call to `otcExecutorAddress` with the `join_trade`
 * selector. The first calldata felt after the selector is the trade_id.
 */
export async function verifyAsOtc(
  provider: RpcProvider,
  poolAddress: string,
  otcExecutorAddress: string,
  noteId: string,
): Promise<OtcVerification | undefined> {
  const { events } = await provider.getEvents({
    address: poolAddress,
    keys: [[ENC_NOTE_CREATED_KEY], [noteId]],
    from_block: { block_number: 0 },
    to_block: "latest",
    chunk_size: 1,
  });
  const event = events[0];
  if (!event) return undefined;

  const txHash = event.transaction_hash;
  const tx = (await provider.getTransactionByHash(txHash)) as unknown as {
    calldata?: string[];
  };
  const calldata = tx.calldata;
  if (!calldata) {
    return { isOtc: false, txHash, blockNumber: Number(event.block_number ?? 0) };
  }

  // Account v3 calldata: [num_calls, (to, selector, calldata_len, ...calldata)*].
  // Scan for a call to the OTC executor with the join_trade selector.
  const otcExecutorBig = BigInt(otcExecutorAddress);
  const joinTradeBig = BigInt(JOIN_TRADE_SELECTOR);
  let i = 1;
  const numCalls = Number(BigInt(calldata[0] ?? "0"));
  for (let c = 0; c < numCalls && i + 3 <= calldata.length; c++) {
    const to = BigInt(calldata[i]!);
    const selector = BigInt(calldata[i + 1]!);
    const innerLen = Number(BigInt(calldata[i + 2]!));
    const innerStart = i + 3;
    if (to === otcExecutorBig && selector === joinTradeBig) {
      // join_trade calldata: [trade_id, actions_len, ...actions]
      const tradeId = calldata[innerStart];
      return {
        isOtc: true,
        txHash,
        blockNumber: Number(event.block_number ?? 0),
        tradeId,
      };
    }
    i = innerStart + innerLen;
  }
  return { isOtc: false, txHash, blockNumber: Number(event.block_number ?? 0) };
}
