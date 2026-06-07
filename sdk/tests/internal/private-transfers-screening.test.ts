import { describe, it, expect } from "vitest";
import { PrivateTransfers } from "../../src/internal/private-transfers.js";
import { screeningCalldataSuffix } from "../../src/internal/screening-calldata.js";
import type { Proof, ProofInvocationResult, ProofProviderInterface } from "../../src/interfaces.js";
import type { PoolCapabilityMode } from "../../src/internal/pool-capability.js";
import type { AdditionalData } from "../../src/internal/proving-service.js";

const POOL_ADDRESS = "0x1";
const CLASS_HASH = "0xclass";
const ACTIONS = ["0xaction1", "0xaction2"];

const SIGNATURE: AdditionalData = {
  signature: {
    issued_at: 1716579600,
    sig_r: "0x6e6f63c878a2fdebb3934de2344fbd4bc04ae47b73561f2a5a170cd0c8a0cb",
    sig_s: "0x58a68a71ca79df6cc71d5b4b4813685f590ede2c686b9096fb350f11298429f",
  },
};

/**
 * Build a PrivateTransfers whose proving provider returns a fixed proof and the
 * given capability mode. Only the surface executeWithInvocation touches is stubbed.
 */
function makeTransfers(
  mode: PoolCapabilityMode | "omit",
  additionalData?: AdditionalData
): PrivateTransfers {
  const proof: Proof = {
    data: "",
    output: [CLASS_HASH, ...ACTIONS],
    proofFacts: [],
    additionalData,
  };
  const provingProvider: ProofProviderInterface = {
    getDefaultDetails: async () => ({}) as never,
    prove: async () => proof,
    ...(mode === "omit" ? {} : { resolvePoolCapability: async () => mode }),
  };
  return new PrivateTransfers({
    account: { address: POOL_ADDRESS } as never,
    viewingKeyProvider: {} as never,
    provingProvider,
    discoveryProvider: {} as never,
    proofInvocationFactory: { parseOutput: () => ({}) } as never,
    poolContractAddress: POOL_ADDRESS,
  });
}

const EMPTY_INVOCATION = {
  invocation: {} as never,
  registry: undefined as never,
  warnings: [],
} satisfies ProofInvocationResult;

async function calldataFor(
  mode: PoolCapabilityMode | "omit",
  additionalData?: AdditionalData
): Promise<string[]> {
  const result = await makeTransfers(mode, additionalData).executeWithInvocation(EMPTY_INVOCATION);
  return result.callAndProof.call.calldata as string[];
}

describe("executeWithInvocation calldata gating", () => {
  it("compatibility pool: no suffix, even when a signature is present", async () => {
    expect(await calldataFor("compatibility", SIGNATURE)).toEqual(ACTIONS);
  });

  it("missing resolvePoolCapability defaults to compatibility (no suffix)", async () => {
    expect(await calldataFor("omit", SIGNATURE)).toEqual(ACTIONS);
  });

  it("screening pool + signature: trailing [0x1, issued_at, sig_r, sig_s]", async () => {
    expect(await calldataFor("screening", SIGNATURE)).toEqual([
      ...ACTIONS,
      ...screeningCalldataSuffix(SIGNATURE),
    ]);
  });

  it("screening pool + no signature: trailing Option::None ([0x1])", async () => {
    expect(await calldataFor("screening", undefined)).toEqual([...ACTIONS, "0x1"]);
  });
});
