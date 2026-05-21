import { constants, ec, hash } from "starknet";
import { MAX_VIEWING_KEY } from "@starkware-libs/starknet-privacy-sdk";
import type { AccountConfig } from "./config.ts";

export function isMainnet(chainId: string): boolean {
  return chainId === constants.StarknetChainId.SN_MAIN;
}

// An account is send-capable iff a private key is present. Mainnet and
// testnet share the same check — a view-only entry (address + viewingKey
// only) is never send-capable.
export function isSendCapable(account: AccountConfig | undefined): boolean {
  return Boolean(account?.privateKey);
}

// Derive the privacy-pool viewing key from a signing key by signing a
// canonical `<chainId>:<poolAddress>` message with ECDSA and folding the
// resulting `(r, s)` pair through Poseidon. Stark-curve ECDSA is
// deterministic (RFC-6979 in starknet.js), so the same signing key + chain
// + pool always yields the same viewing key — users can omit `viewingKey`
// from pasted JSON without losing access to their notes across reloads.
//
// The pool contract enforces `1 <= k < ORDER/2` (see
// `packages/privacy/src/utils.cairo:is_canonical_key`) — negating an
// upper-half value folds it into the lower half while preserving the
// public-key x-coordinate, matching the Cairo test helpers. Poseidon's
// output is in `[0, p)` (p = Stark prime > ORDER), so reduce mod ORDER
// before folding, and bump 0 to 1 in the vanishingly unlikely case.
export function deriveViewingKey(privateKey: string, chainId: string, poolAddress: string): bigint {
  const messageHash = hash.starknetKeccak(`${chainId}:${poolAddress}`);
  const signature = ec.starkCurve.sign(`0x${messageHash.toString(16)}`, privateKey);
  const folded = BigInt(hash.computePoseidonHashOnElements([signature.r, signature.s]));
  const order = ec.starkCurve.CURVE.n;
  const reduced = folded % order;
  const canonical = reduced < MAX_VIEWING_KEY ? reduced : order - reduced;
  return canonical === 0n ? 1n : canonical;
}

// Returns the effective account with `viewingKey` filled in (either the
// explicit one, or derived from `privateKey`). Returns `undefined` when the
// account can't produce a viewing key at all.
export function withViewingKey(
  account: AccountConfig | undefined,
  chainId: string,
  poolAddress: string
): AccountConfig | undefined {
  if (!account) return undefined;
  if (account.viewingKey) return account;
  if (account.privateKey) {
    const derived = deriveViewingKey(account.privateKey, chainId, poolAddress);
    return { ...account, viewingKey: `0x${derived.toString(16)}` };
  }
  return undefined;
}
