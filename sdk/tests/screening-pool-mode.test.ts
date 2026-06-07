import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/test-fixtures.js";
import { SimplePrivateTransfersImpl } from "../src/simple-private-transfers.js";
import { COMPATIBILITY_POOL_CLASS_HASHES } from "../src/internal/pool-mode.js";
import { toHex } from "../src/utils/convert.js";

/**
 * End-to-end calldata-shape wiring: real PrivateTransfers + MockProofProvider
 * (whose proof payload is headed by the mock pool's class hash, driving the
 * SDK's class-hash mode detection) + the mock pool (whose apply_actions
 * enforces a well-formed calldata shape). Proves one SDK build talks to both
 * pool versions without reverting on calldata arity.
 */
async function depositCalldata(poolClassHash: string): Promise<string[]> {
  const { mocknet, env, transfers } = createTestEnv();
  mocknet.pool.classHash = poolClassHash;

  mocknet.executeOutside(await transfers.alice.build().register().execute());

  const alice = new SimplePrivateTransfersImpl(transfers.alice);
  const result = await alice.deposit(env.ace, 100n);
  // apply_actions asserts a well-formed (or absent) attestation suffix; a throw
  // here would mean the emitted shape mismatches what the pool version expects.
  mocknet.executeOutside(result);
  return result.callAndProof.call.calldata as string[];
}

describe("deposit calldata shape per pool class hash", () => {
  it("pinned pool class: no screening attestation suffix; unpinned: suffixed", async () => {
    const compat = await depositCalldata(toHex(COMPATIBILITY_POOL_CLASS_HASHES[0]));
    const screening = await depositCalldata("0xdec1a23ed");
    // The screening-capable pool appends exactly one extra felt (the None tag,
    // 0x1 in Cairo's Option Serde), since MockProofProvider attaches no signature.
    expect(screening.length).toBe(compat.length + 1);
    expect(screening[screening.length - 1]).toBe("0x1");
  });
});
