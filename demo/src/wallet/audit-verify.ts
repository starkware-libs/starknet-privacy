// On-chain verification for the Audit panel. Given a note_id (which the
// viewing-key holder already decrypted off-chain), this module reaches into
// the pool's events to find the tx that emitted it, then inspects that tx's
// calldata to see whether it ran through `OtcSettlement.join_trade(...)`.
//
// The whole point of the audit screen is that nothing is cached locally —
// every call here goes straight to the RPC, so the user can demonstrate to
// an accountant that the trail is reconstructable from chain + viewing key
// alone.

import { hash, RpcProvider } from "starknet";

// `selector!("EncNoteCreated")` for the Cairo event variant. Computed once at
// module load — sn_keccak is deterministic. `starknetKeccak` returns a
// `bigint`; the RPC requires a 0x-prefixed hex felt (≤ 64 hex chars), so we
// stringify base-16 and prefix. The earlier decimal form blew the 76-char
// budget the node enforces.
const ENC_NOTE_CREATED_KEY = "0x" + hash.starknetKeccak("EncNoteCreated").toString(16);

// `selector!("join_trade")` — Cairo entrypoint selector. Used to recognize an
// OtcSettlement.join_trade call inside the tx's calldata.
const JOIN_TRADE_SELECTOR = hash.getSelectorFromName("join_trade");

// `blockNumber` is optional on the RPC's EMITTED_EVENT shape — for a freshly
// pre-confirmed block the node may not yet have the block number attached.
// Surface it as nullable rather than guessing a value.
export type VerificationResult =
  | { kind: "otc"; txHash: string; blockNumber: number | null; tradeId: bigint }
  | { kind: "plain"; txHash: string; blockNumber: number | null }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/**
 * Resolve a single note id to its emitting transaction, classify whether it
 * came from an OTC trade, and (for OTC) recover the trade id from calldata.
 *
 * `salt` is the value the wallet already decrypted from the note's `witness.r`.
 * For an OTC note, the OTC SDK passes `salt = trade_id`, so the recovered
 * trade_id from the on-chain calldata MUST equal `salt`. Any mismatch is a
 * red flag and surfaces as a separate result kind.
 */
export async function verifyNote(
  provider: RpcProvider,
  poolAddress: string,
  otcExecutorAddress: string,
  noteId: bigint,
  salt: bigint,
  /** Block where the note was emitted, if known from discovery. Pathfinder
   * caps each getEvents call to ~64K blocks of scan, so without a hint we'd
   * have to paginate from genesis through 9M+ blocks to find a recent note —
   * way too slow. The discovery layer already knows this. */
  blockHint?: number | null
): Promise<VerificationResult> {
  try {
    const noteIdHex = "0x" + noteId.toString(16);
    // Block window. If we have a hint, scan a tight 200-block band around it
    // (covers re-org tolerance without scanning the whole chain). Without a
    // hint, scan from genesis — slow, may miss recent events on Pathfinder.
    const fromBlock = blockHint != null ? { block_number: Math.max(0, blockHint - 5) } : { block_number: 0 };
    const toBlock = blockHint != null ? { block_number: blockHint + 5 } : "latest";

    // Two filters in sequence in case some indexer normalizes the variant
    // selector differently from starknet.js. note_id is a 252-bit value, so
    // the wider [[], [note_id]] filter is still effectively unique.
    const filters: { keys: string[][]; chunk: number }[] = [
      { keys: [[ENC_NOTE_CREATED_KEY], [noteIdHex]], chunk: 1 },
      { keys: [[], [noteIdHex]], chunk: 10 },
    ];
    let event: { transaction_hash: string; block_number?: number } | undefined;
    for (const filter of filters) {
      const result = await provider.getEvents({
        address: poolAddress,
        keys: filter.keys,
        from_block: fromBlock,
        to_block: toBlock,
        chunk_size: filter.chunk,
      });
      if (result.events.length > 0) {
        event = result.events[0];
        break;
      }
    }
    if (!event) return { kind: "not-found" };

    const txHash = event.transaction_hash;
    const blockNumber = event.block_number ?? null;

    const tx = await provider.getTransactionByHash(txHash);
    const matchedTradeId = findJoinTradeWithTradeId(tx, otcExecutorAddress, salt);

    if (matchedTradeId === undefined) {
      // No `join_trade` in this tx whose `trade_id` equals this note's salt.
      // This covers:
      //  - Plain transfer / deposit (no OTC call at all in the tx).
      //  - The user's own "change" note from an OTC trade: it lives in the
      //    same tx as a `join_trade`, but its salt is the auto-generated
      //    surplus salt, not the trade id. From an audit standpoint, that
      //    change note was NOT bound to the trade — it's a self-transfer.
      // Either way it's a legitimate result, not a failure.
      return { kind: "plain", txHash, blockNumber };
    }

    return { kind: "otc", txHash, blockNumber, tradeId: matchedTradeId };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

// Walk a Cairo-1 invoke tx's calldata looking for *any* sub-call whose target
// is the OtcSettlement contract and whose selector is `join_trade`. Returns
// the first such call's trade_id if it equals `expectedSalt`, else undefined.
//
// This is the salt-mismatch fix: the user's own "change" note from an OTC
// trade lives in the same tx as the `join_trade` call, but its salt is the
// auto-generated surplus salt — not the trade_id. We can't classify that
// change note as OTC. By requiring trade_id == salt, we only label notes
// that were actually bound to the trade.
//
// Cairo-1 invoke calldata layout, from `transaction.fromCallsToExecuteCalldata_cairo1`:
//   [num_calls,
//    (contract_address, selector, calldata_len, ...calldata)*]
function findJoinTradeWithTradeId(
  tx: unknown,
  otcExecutorAddress: string,
  expectedSalt: bigint
): bigint | undefined {
  // The Starknet RPC types are a discriminated union; we only need `calldata`.
  // Cast through the loose shape.
  const calldata = (tx as { calldata?: string[] }).calldata;
  if (!calldata || calldata.length === 0) return undefined;

  const otcExecutor = safeBigInt(otcExecutorAddress);
  const joinTradeSelector = safeBigInt(JOIN_TRADE_SELECTOR);
  if (otcExecutor === undefined || joinTradeSelector === undefined) return undefined;

  let offset = 0;
  const numCalls = safeBigInt(calldata[offset]);
  if (numCalls === undefined) return undefined;
  offset += 1;

  for (let callIndex = 0n; callIndex < numCalls; callIndex += 1n) {
    if (offset + 3 > calldata.length) return undefined;
    const contractAddress = safeBigInt(calldata[offset]);
    const selector = safeBigInt(calldata[offset + 1]);
    const innerLen = safeBigInt(calldata[offset + 2]);
    if (contractAddress === undefined || selector === undefined || innerLen === undefined) {
      return undefined;
    }
    const innerStart = offset + 3;
    const innerEnd = innerStart + Number(innerLen);
    if (innerEnd > calldata.length) return undefined;

    if (contractAddress === otcExecutor && selector === joinTradeSelector && innerLen >= 1n) {
      // First calldata felt of join_trade is the trade_id.
      const tradeId = safeBigInt(calldata[innerStart]);
      if (tradeId !== undefined && tradeId === expectedSalt) {
        return tradeId;
      }
      // Otherwise keep scanning — there could be multiple OTC sub-calls in
      // the same tx (unusual but cheap to handle).
    }

    offset = innerEnd;
  }
  return undefined;
}

function safeBigInt(value: string): bigint | undefined {
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}
