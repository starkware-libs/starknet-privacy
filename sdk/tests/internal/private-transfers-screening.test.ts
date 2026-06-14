import { describe, it, expect } from "vitest";
import { PrivateTransfers } from "../../src/internal/private-transfers.js";
import { screeningCalldataSuffix } from "../../src/internal/screening-calldata.js";
import {
  COMPATIBILITY_POOL_CLASS_HASHES,
  type PoolCapabilityMode,
} from "../../src/internal/pool-mode.js";
import type { Proof, ProofInvocationResult, ProofProviderInterface } from "../../src/interfaces.js";
import type { AdditionalData } from "../../src/internal/proving-service.js";
import { toHex } from "../../src/utils/convert.js";

const POOL_ADDRESS = "0x1";
// A pinned (deployed pre-screening) pool class vs. any other class hash.
const COMPATIBILITY_CLASS_HASH = toHex(COMPATIBILITY_POOL_CLASS_HASHES[0]);
const SCREENING_CLASS_HASH = "0xdec1a23ed";
const ACTIONS = ["0xaction1", "0xaction2"];

const SIGNATURE: AdditionalData = {
  signature: {
    issued_at: 1716579600,
    sig_r: "0x6e6f63c878a2fdebb3934de2344fbd4bc04ae47b73561f2a5a170cd0c8a0cb",
    sig_s: "0x58a68a71ca79df6cc71d5b4b4813685f590ede2c686b9096fb350f11298429f",
  },
};

/**
 * Build a PrivateTransfers whose proving provider returns a fixed proof headed
 * by the given pool class hash. Only the surface executeWithInvocation touches
 * is stubbed.
 */
function makeTransfers(
  poolClassHash: string,
  additionalData?: AdditionalData,
  poolMode?: PoolCapabilityMode
): PrivateTransfers {
  const proof: Proof = {
    data: "",
    output: [poolClassHash, ...ACTIONS],
    proofFacts: [],
    additionalData,
  };
  const provingProvider: ProofProviderInterface = {
    getDefaultDetails: async () => ({}) as never,
    prove: async () => proof,
  };
  return new PrivateTransfers({
    account: { address: POOL_ADDRESS } as never,
    viewingKeyProvider: {} as never,
    provingProvider,
    discoveryProvider: {} as never,
    proofInvocationFactory: { parseOutput: () => ({}) } as never,
    poolContractAddress: POOL_ADDRESS,
    poolMode,
  });
}

const EMPTY_INVOCATION = {
  invocation: {} as never,
  registry: undefined as never,
  warnings: [],
} satisfies ProofInvocationResult;

async function calldataFor(
  poolClassHash: string,
  additionalData?: AdditionalData,
  poolMode?: PoolCapabilityMode
): Promise<string[]> {
  const result = await makeTransfers(poolClassHash, additionalData, poolMode).executeWithInvocation(
    EMPTY_INVOCATION
  );
  return result.callAndProof.call.calldata as string[];
}

describe("executeWithInvocation calldata gating", () => {
  it("pinned pool class hash: no suffix, even when a signature is present", async () => {
    expect(await calldataFor(COMPATIBILITY_CLASS_HASH, SIGNATURE)).toEqual(ACTIONS);
  });

  it("unpinned pool class hash + signature: trailing [0x0, issued_at, sig_r, sig_s]", async () => {
    expect(await calldataFor(SCREENING_CLASS_HASH, SIGNATURE)).toEqual([
      ...ACTIONS,
      ...screeningCalldataSuffix(SIGNATURE),
    ]);
  });

  it("unpinned pool class hash + no signature: trailing Option::None ([0x1])", async () => {
    expect(await calldataFor(SCREENING_CLASS_HASH, undefined)).toEqual([...ACTIONS, "0x1"]);
  });

  it("poolMode compatibility override wins over an unpinned class hash", async () => {
    expect(await calldataFor(SCREENING_CLASS_HASH, SIGNATURE, "compatibility")).toEqual(ACTIONS);
  });

  it("poolMode screening override wins over a pinned class hash", async () => {
    expect(await calldataFor(COMPATIBILITY_CLASS_HASH, undefined, "screening")).toEqual([
      ...ACTIONS,
      "0x1",
    ]);
  });
});
