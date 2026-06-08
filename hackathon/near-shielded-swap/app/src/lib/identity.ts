import { ec, hash, type TypedData, type Signature } from "starknet";
import type { AccountInterface } from "starknet";
import { CHAIN, POOL_CONTRACT_ADDRESS } from "./chain";

// The pool enforces `1 <= k <= ORDER/2` (`packages/privacy/src/utils.cairo`
// :is_canonical_key) — values in the upper half are folded into the lower
// half via negation, preserving the public-key x-coordinate. This mirrors
// `demo/src/session.ts:deriveViewingKey` but uses the wallet's typed-data
// signature as the entropy source (we don't have the wallet's raw private key).
const STARK_ORDER = ec.starkCurve.CURVE.n;
const MAX_VIEWING_KEY = STARK_ORDER / 2n;

export interface ShieldedIdentity {
  privateKey: bigint;
  publicKey: bigint;
}

function buildDerivationTypedData(): TypedData {
  return {
    domain: {
      name: "Shielded Swap",
      version: "1",
      chainId: CHAIN.chainId,
    },
    types: {
      StarkNetDomain: [
        { name: "name", type: "felt" },
        { name: "version", type: "felt" },
        { name: "chainId", type: "felt" },
      ],
      Derive: [
        { name: "purpose", type: "felt" },
        { name: "pool", type: "felt" },
      ],
    },
    primaryType: "Derive",
    message: {
      purpose: "viewing-key-v1",
      pool: POOL_CONTRACT_ADDRESS,
    },
  };
}

function extractRS(sig: Signature): { r: bigint; s: bigint } {
  if (Array.isArray(sig)) {
    // Wallets typically return [r, s] or a length-prefixed [n, r, s, ...].
    // Detect the prefixed form when the first element equals length - 1.
    const a = sig as readonly (string | bigint)[];
    const first = BigInt(a[0] ?? 0n);
    if (first === BigInt(a.length - 1)) {
      return { r: BigInt(a[1] ?? 0n), s: BigInt(a[2] ?? 0n) };
    }
    return { r: BigInt(a[0] ?? 0n), s: BigInt(a[1] ?? 0n) };
  }
  return { r: BigInt(sig.r), s: BigInt(sig.s) };
}

export async function deriveIdentity(
  account: AccountInterface,
): Promise<ShieldedIdentity> {
  const data = buildDerivationTypedData();
  const sig = await account.signMessage(data);
  const { r, s } = extractRS(sig);

  const folded = BigInt(hash.computePoseidonHashOnElements([r, s]));
  const reduced = folded % STARK_ORDER;
  const canonical = reduced < MAX_VIEWING_KEY ? reduced : STARK_ORDER - reduced;
  const privateKey = canonical === 0n ? 1n : canonical;

  const publicKeyHex = ec.starkCurve.getStarkKey(`0x${privateKey.toString(16)}`);
  const publicKey = BigInt(publicKeyHex);

  return { privateKey, publicKey };
}

// Short identifier for the connected user's public viewing key — safe to show
// in the UI; the private key is never displayed.
export function publicKeyFingerprint(identity: ShieldedIdentity): string {
  const pk = identity.publicKey.toString(16).padStart(64, "0");
  return `0x${pk.slice(0, 6)}…${pk.slice(-4)}`;
}
