// Viewing-key derivation for wallet-extension users.
//
// The wallet holds the signing key; we don't have direct access. To derive
// a viewing key without leaking, we ask the wallet to sign a canonical
// typed-data message of the form `<chainId>:<poolAddress>` — the same shape
// the JSON-paste path uses (see session.ts:deriveViewingKey). Stark-curve
// ECDSA is deterministic (RFC-6979 in starknet.js), so signing the same
// message with the same key always yields the same (r, s) pair, so the
// derived viewing key is stable across reloads.
//
// We Poseidon-fold (r, s) into a single felt, reduce mod the stark order,
// and ensure canonicity (k in [1, ORDER/2)) — matching session.ts so notes
// discovered via the JSON path and the wallet-extension path are identical.
//
// The derived key is cached in localStorage so the wallet prompt only fires
// once per (chainId, poolAddress, address) tuple.

import { ec, hash } from "starknet";
import { MAX_VIEWING_KEY } from "starknet-sdk";
import type { ConnectedWallet, ViewingKeyDerivation } from "./types.ts";

const STORE_PREFIX = "wallet:ext-vk:";

function storeKey(chainId: string, poolAddress: string, address: string): string {
  // Lower-cased canonical components so a re-connect with a different
  // address casing still resolves the same cached key.
  return `${STORE_PREFIX}${chainId.toLowerCase()}:${poolAddress.toLowerCase()}:${address.toLowerCase()}`;
}

export function loadCachedViewingKey(
  chainId: string,
  poolAddress: string,
  address: string
): bigint | undefined {
  try {
    const stored = localStorage.getItem(storeKey(chainId, poolAddress, address));
    if (!stored) return undefined;
    return BigInt(stored);
  } catch {
    return undefined;
  }
}

function saveCachedViewingKey(
  chainId: string,
  poolAddress: string,
  address: string,
  viewingKey: bigint
): void {
  try {
    localStorage.setItem(storeKey(chainId, poolAddress, address), "0x" + viewingKey.toString(16));
  } catch {
    // localStorage unavailable — silent. The viewing key stays in memory for
    // this session; user will be prompted again on reload.
  }
}

export function clearCachedViewingKey(
  chainId: string,
  poolAddress: string,
  address: string
): void {
  try {
    localStorage.removeItem(storeKey(chainId, poolAddress, address));
    localStorage.removeItem(proofKeyStoreKey(chainId, poolAddress, address));
  } catch {
    // ignored
  }
}

/**
 * Ask the connected wallet to sign the canonical viewing-key message and
 * derive the viewing key from the resulting signature. Cached on success.
 *
 * Returns `kind: "rejected"` if the user dismissed the wallet prompt.
 */
export async function deriveViewingKeyFromWallet(
  wallet: ConnectedWallet,
  poolAddress: string
): Promise<ViewingKeyDerivation> {
  // Restore both keys from cache if available — both are deterministic from
  // the same wallet signature so they cache together.
  const cachedViewing = loadCachedViewingKey(wallet.chainId, poolAddress, wallet.address);
  const cachedProof = loadCachedProofKey(wallet.chainId, poolAddress, wallet.address);
  if (cachedViewing !== undefined && cachedProof !== undefined) {
    return { kind: "ok", viewingKey: cachedViewing, proofPrivateKey: cachedProof };
  }

  const typedData = canonicalTypedData(wallet.chainId, poolAddress);
  let signature: string[];
  try {
    const result = await wallet.wallet.request({
      type: "wallet_signTypedData",
      params: typedData,
    });
    signature = normalizeSignature(result);
  } catch (error) {
    if (isUserRejected(error)) return { kind: "rejected" };
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  if (signature.length < 2) {
    return { kind: "error", message: "Signature has fewer than 2 components (r, s)" };
  }

  let r: bigint;
  let s: bigint;
  try {
    r = BigInt(signature[0]);
    s = BigInt(signature[1]);
  } catch {
    return { kind: "error", message: "Signature components are not valid felts" };
  }

  // Two domain-separated derivations from the same wallet signature:
  //   - viewing key:  Poseidon([r, s])         — same algorithm as session.ts
  //                                              so a JSON-paste account and a
  //                                              wallet-ext account with the
  //                                              same canonical (r, s) end up
  //                                              with the same viewing key.
  //   - proof key:    Poseidon([r, s, "proof"]) — distinct so the proof Signer
  //                                              key isn't the same scalar as
  //                                              the viewing key.
  const viewingKey = canonicalize(BigInt(hash.computePoseidonHashOnElements([r, s])));
  const proofPrivateKey = stableProofKey(BigInt(
    hash.computePoseidonHashOnElements([r, s, BigInt("0x70726f6f66")]) // "proof" as felt
  ));

  saveCachedViewingKey(wallet.chainId, poolAddress, wallet.address, viewingKey);
  saveCachedProofKey(wallet.chainId, poolAddress, wallet.address, proofPrivateKey);
  return { kind: "ok", viewingKey, proofPrivateKey };
}

// Reduce mod stark-curve order; fold non-canonical (k ≥ N/2) into canonical
// half; bump 0 to 1. Matches session.ts:deriveViewingKey so the same wallet
// signature gives the same viewing key as a JSON-paste account would.
function canonicalize(folded: bigint): bigint {
  const order = ec.starkCurve.CURVE.n;
  const reduced = folded % order;
  const canonical = reduced < MAX_VIEWING_KEY ? reduced : order - reduced;
  return canonical === 0n ? 1n : canonical;
}

// Stark-curve private keys: 1 ≤ k < N. No need for the half-curve canonical
// form (that's a viewing-key invariant); just reduce mod N and bump 0 to 1.
function stableProofKey(folded: bigint): bigint {
  const order = ec.starkCurve.CURVE.n;
  const reduced = folded % order;
  return reduced === 0n ? 1n : reduced;
}

// --- proof-key cache, parallel to the viewing-key cache ---

const PROOF_KEY_STORE_PREFIX = "wallet:ext-pk:";

function proofKeyStoreKey(chainId: string, poolAddress: string, address: string): string {
  return `${PROOF_KEY_STORE_PREFIX}${chainId.toLowerCase()}:${poolAddress.toLowerCase()}:${address.toLowerCase()}`;
}

export function loadCachedProofKey(
  chainId: string,
  poolAddress: string,
  address: string
): bigint | undefined {
  try {
    const stored = localStorage.getItem(proofKeyStoreKey(chainId, poolAddress, address));
    if (!stored) return undefined;
    return BigInt(stored);
  } catch {
    return undefined;
  }
}

function saveCachedProofKey(
  chainId: string,
  poolAddress: string,
  address: string,
  proofPrivateKey: bigint
): void {
  try {
    localStorage.setItem(
      proofKeyStoreKey(chainId, poolAddress, address),
      "0x" + proofPrivateKey.toString(16)
    );
  } catch {
    // localStorage unavailable — silent.
  }
}

// SNIP-12 typed data for the viewing-key derivation. The shape is unique to
// this app so a signature given here can't be replayed against another dapp's
// intended message. Domain `name` carries that scope; `version` lets us
// rotate the derivation later without colliding cached keys.
function canonicalTypedData(chainId: string, poolAddress: string) {
  return {
    domain: {
      name: "Veil Viewing Key",
      version: "1",
      chainId,
      revision: "1",
    },
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      Derive: [
        { name: "Purpose", type: "shortstring" },
        { name: "Pool", type: "ContractAddress" },
      ],
    },
    primaryType: "Derive",
    message: {
      Purpose: "viewing-key",
      Pool: poolAddress,
    },
  };
}

function normalizeSignature(result: unknown): string[] {
  if (Array.isArray(result)) {
    return result.map((value) =>
      typeof value === "string" ? value : "0x" + BigInt(value as number | bigint).toString(16)
    );
  }
  // Some wallets return an object { r, s } or { signature }; tolerate both.
  if (typeof result === "object" && result !== null) {
    const obj = result as { r?: string; s?: string; signature?: string[] };
    if (Array.isArray(obj.signature)) return obj.signature;
    if (typeof obj.r === "string" && typeof obj.s === "string") return [obj.r, obj.s];
  }
  return [];
}

function isUserRejected(error: unknown): boolean {
  // Wallets report rejection in a few different ways. Match on common
  // markers rather than throwing the wrong "error" classification.
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /reject|deni|cancel/i.test(message);
}
