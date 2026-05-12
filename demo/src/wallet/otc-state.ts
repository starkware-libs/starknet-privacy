import { useEffect, useState } from "react";
import { hash, type RpcProvider } from "starknet";

// Phase of an OTC trade as visible from the OtcSettlement contract storage.
//
//   "fresh"   — no first leg yet. Submitting becomes the first leg.
//   "second"  — first_hash != 0; submitting will atomically fire the trade.
//   "loading" — RPC roundtrip in flight.
//   "idle"    — no trade_id entered, nothing to check.
//   "error"   — RPC call failed (transient; UI keeps the previous phase visible).
//
// We can't distinguish "fresh" from "already-settled": join_trade zeros both
// hashes after the second leg fires. UI-wise that's fine — submitting against
// a settled trade_id will revert at store_actions time with a clear error.
export type TradePhase = "idle" | "loading" | "fresh" | "second" | "error";

export type TradeState = {
  phase: TradePhase;
  firstHash: bigint | null;
  /** When non-null, briefly held while a fresh fetch is in flight. */
  staleFirstHash: bigint | null;
};

const EMPTY: TradeState = { phase: "idle", firstHash: null, staleFirstHash: null };

// Compute the storage slot of `trade_hashes[trade_id].first_hash` on the
// OtcSettlement contract. Cairo's `starknet::storage::Map<felt252, V>` lays
// out an entry at `pedersen(sn_keccak(name), key)`; struct fields then occupy
// consecutive felts starting at that base. `TradeHashes.first_hash` is the
// first field, so its slot equals the base address.
function firstHashSlot(tradeId: bigint): string {
  const base = hash.starknetKeccak("trade_hashes");
  return hash.computePedersenHash(base.toString(), `0x${tradeId.toString(16)}`);
}

// Parse the user's `trade_id` input. We accept hex (0x…) or decimal so a
// counterparty can paste either. Empty / invalid → `null` (UI stays idle).
function parseTradeId(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

export function useTradeState(
  provider: RpcProvider | undefined,
  executorAddress: string | undefined,
  tradeIdInput: string,
  debounceMs = 400
): TradeState {
  const [state, setState] = useState<TradeState>(EMPTY);

  useEffect(() => {
    const tradeId = parseTradeId(tradeIdInput);
    if (!provider || !executorAddress || tradeId === null) {
      setState(EMPTY);
      return;
    }

    // Hold previous firstHash through the debounce so the banner doesn't
    // flicker between keystrokes — only flip to "loading" once we actually
    // dispatch the RPC call.
    setState((previous) => ({
      ...previous,
      staleFirstHash: previous.firstHash,
    }));

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setState((previous) => ({ ...previous, phase: "loading" }));
      try {
        const slot = firstHashSlot(tradeId);
        const raw = await provider.getStorageAt(executorAddress, slot, "pre_confirmed");
        if (cancelled) return;
        // Newer starknet.js returns `string | STORAGE_RESULT`. With no
        // response flags we expect the bare hex string, but normalize both
        // shapes defensively so a future flag change doesn't silently break
        // the phase detection.
        const rawValue = typeof raw === "string" ? raw : raw.value;
        const firstHash = BigInt(rawValue);
        setState({
          phase: firstHash === 0n ? "fresh" : "second",
          firstHash,
          staleFirstHash: null,
        });
      } catch {
        if (cancelled) return;
        setState((previous) => ({ ...previous, phase: "error" }));
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [provider, executorAddress, tradeIdInput, debounceMs]);

  return state;
}
