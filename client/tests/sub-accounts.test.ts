import { describe, it, expect } from "vitest";
import { resolveSubAccounts } from "../src/index.js";
import type { SubAccountAnonymizerContract, SubAccountInfo } from "../src/index.js";

const PARTIAL = 0x7n;

/**
 * Fake anonymizer contract standing in for the typed `get_sub_accounts` view. For `[from, to)` it
 * yields one `SubAccountInfo` per nonce (a distinct address, `is_deployed` per `deployed(nonce)`),
 * replicating the Cairo `until_undeployed` behavior: when set, it stops at the first undeployed nonce and
 * returns the deployed prefix. Optionally records each call's `[from, to, untilUndeployed]`.
 */
function mockAnonymizer(
  deployed: (nonce: number) => boolean,
  calls?: Array<[number, number, boolean]>
): SubAccountAnonymizerContract {
  return {
    get_sub_accounts: async (
      _partial: bigint,
      from: number,
      to: number,
      untilUndeployed: boolean
    ): Promise<SubAccountInfo[]> => {
      calls?.push([from, to, untilUndeployed]);
      const infos: SubAccountInfo[] = [];
      for (let nonce = from; nonce < to; nonce++) {
        if (untilUndeployed && !deployed(nonce)) break;
        // The typedv2 decoder yields bigint for the Cairo u64 nonce and ContractAddress address.
        infos.push({
          nonce: BigInt(nonce),
          address: 0x1000n + BigInt(nonce),
          is_deployed: deployed(nonce),
        });
      }
      return infos;
    },
  } as unknown as SubAccountAnonymizerContract;
}

describe("resolveSubAccounts", () => {
  it("returns every nonce in [start, end) with its stored address (untilUndeployed default)", async () => {
    const infos = await resolveSubAccounts({
      anonymizer: mockAnonymizer(() => true),
      partialCommitment: PARTIAL,
      range: { end: 3 },
    });
    expect(infos.map((info) => info.nonce)).toEqual([0n, 1n, 2n]);
    expect(infos.every((info) => info.is_deployed)).toBe(true);
    expect(new Set(infos.map((info) => info.address)).size).toBe(3);
  });

  it("honors start and marks undeployed nonces", async () => {
    const infos = await resolveSubAccounts({
      anonymizer: mockAnonymizer(() => false),
      partialCommitment: PARTIAL,
      range: { start: 5, end: 7 },
    });
    expect(infos.map((info) => info.nonce)).toEqual([5n, 6n]);
    expect(infos.every((info) => !info.is_deployed)).toBe(true);
  });

  it("defaults end to start + DEFAULT_ADDRESS_RANGE_END", async () => {
    const fromZero = await resolveSubAccounts({
      anonymizer: mockAnonymizer(() => false),
      partialCommitment: PARTIAL,
      range: {},
    });
    expect(fromZero.map((info) => info.nonce)).toEqual([...Array(100).keys()].map(BigInt));

    // A non-zero start shifts the whole window instead of shrinking it: [10, 110).
    const fromTen = await resolveSubAccounts({
      anonymizer: mockAnonymizer(() => false),
      partialCommitment: PARTIAL,
      range: { start: 10 },
    });
    expect(fromTen).toHaveLength(100);
    expect(fromTen[0].nonce).toBe(10n);
    expect(fromTen[99].nonce).toBe(109n);
  });

  it("paginates across MAX_SCAN_RANGE windows", async () => {
    const calls: Array<[number, number, boolean]> = [];
    const infos = await resolveSubAccounts({
      anonymizer: mockAnonymizer(() => true, calls),
      partialCommitment: PARTIAL,
      range: { end: 1025 },
    });
    expect(infos).toHaveLength(1025);
    expect(infos[1024].nonce).toBe(1024n);
    expect(calls).toEqual([
      [0, 1024, false],
      [1024, 1025, false],
    ]);
  });

  it("untilUndeployed:true returns the deployed prefix and stops at the first gap", async () => {
    const infos = await resolveSubAccounts({
      anonymizer: mockAnonymizer((nonce) => nonce < 3), // nonces 0,1,2 deployed
      partialCommitment: PARTIAL,
      range: { end: 50, untilUndeployed: true },
    });
    expect(infos.map((info) => info.nonce)).toEqual([0n, 1n, 2n]);
    expect(infos.every((info) => info.is_deployed)).toBe(true);
  });

  it("untilUndeployed:true stops paginating once a window comes back short", async () => {
    const calls: Array<[number, number, boolean]> = [];
    const infos = await resolveSubAccounts({
      anonymizer: mockAnonymizer((nonce) => nonce < 1030, calls),
      partialCommitment: PARTIAL,
      range: { end: 4096, untilUndeployed: true },
    });
    // First window [0,1024) is full, so it continues; [1024,2048) stops at nonce 1030.
    expect(infos).toHaveLength(1030);
    expect(infos[1029].nonce).toBe(1029n);
    expect(calls).toEqual([
      [0, 1024, true],
      [1024, 2048, true],
    ]);
  });
});
