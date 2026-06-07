import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/test-fixtures.js";
import { SimplePrivateTransfersImpl } from "../src/simple-private-transfers.js";

/**
 * End-to-end calldata-shape wiring: real PrivateTransfers + MockProofProvider
 * (which resolves capability from the pool's screening_version) + the mock pool
 * (whose apply_actions enforces the on-chain calldata shape). Proves one SDK
 * build talks to both pool versions without reverting on calldata arity.
 */
async function depositCalldata(screeningVersion: bigint): Promise<string[]> {
  const { mocknet, env, transfers } = createTestEnv();
  mocknet.pool.setScreeningVersion(screeningVersion);

  mocknet.executeOutside(await transfers.alice.build().register().execute());

  const alice = new SimplePrivateTransfersImpl(transfers.alice);
  const result = await alice.deposit(env.ace, 100n);
  // apply_actions asserts a well-formed (or absent) attestation suffix; a throw
  // here would mean the emitted shape mismatches what the pool version expects.
  mocknet.executeOutside(result);
  return result.callAndProof.call.calldata as string[];
}

describe("deposit calldata shape per pool version", () => {
  it("current pool (screening_version 0): no screening attestation suffix", async () => {
    const compat = await depositCalldata(0n);
    const screening = await depositCalldata(1n);
    // The screening-capable pool appends exactly one extra felt (the None tag,
    // 0x1 in Cairo's Option Serde), since MockProofProvider attaches no signature.
    expect(screening.length).toBe(compat.length + 1);
    expect(screening[screening.length - 1]).toBe("0x1");
  });
});
