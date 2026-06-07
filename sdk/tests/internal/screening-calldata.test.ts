import { describe, expect, it } from "vitest";
import { screeningCalldataSuffix } from "../../src/internal/screening-calldata.js";
import { PrivateTransfers } from "../../src/internal/private-transfers.js";
import type {
  DiscoveryProviderInterface,
  PrivateTransfersUser,
  Proof,
  ProofInvocationResult,
  ProofProviderInterface,
  ViewingKeyProvider,
} from "../../src/interfaces.js";
import type { ProofInvocationFactoryInterface } from "../../src/internal/proof-invocation-factory.js";
import type { ScreeningSignature } from "../../src/internal/proving-service.js";

const SIGNATURE: ScreeningSignature = {
  issued_at: 1716579600,
  sig_r: "0x6e6f63c8",
  sig_s: "0x58a68a71",
};

// 1716579600 in hex.
const ISSUED_AT_FELT = "0x6650ed10";

describe("screeningCalldataSuffix", () => {
  it("encodes a missing additional_data as Option::None", () => {
    expect(screeningCalldataSuffix(undefined)).toEqual(["0x0"]);
  });

  it("encodes additional_data without a signature as Option::None", () => {
    expect(screeningCalldataSuffix({})).toEqual(["0x0"]);
  });

  it("encodes a signature as Option::Some with hex issued_at and verbatim felts", () => {
    expect(screeningCalldataSuffix({ signature: SIGNATURE })).toEqual([
      "0x1",
      ISSUED_AT_FELT,
      SIGNATURE.sig_r,
      SIGNATURE.sig_s,
    ]);
  });
});

describe("executeWithInvocation screening calldata", () => {
  function makeTransfers(proof: Proof): PrivateTransfers {
    const provingProvider = {
      prove: async () => proof,
    } as unknown as ProofProviderInterface;
    return new PrivateTransfers({
      account: { address: "0x1" } as PrivateTransfersUser,
      viewingKeyProvider: {} as ViewingKeyProvider,
      provingProvider,
      discoveryProvider: {} as DiscoveryProviderInterface,
      proofInvocationFactory: {
        parseOutput: () => [],
      } as unknown as ProofInvocationFactoryInterface,
      poolContractAddress: "0x123",
    });
  }

  const invocationResult = {
    invocation: {},
    registry: {},
    warnings: [],
  } as unknown as ProofInvocationResult;

  it("appends the Option::Some attestation felts after the action span", async () => {
    const proof: Proof = {
      data: "",
      output: ["0xclass", "0xa1", "0xa2"],
      proofFacts: [],
      additionalData: { signature: SIGNATURE },
    };
    const result = await makeTransfers(proof).executeWithInvocation(invocationResult);
    expect(result.callAndProof.call.calldata).toEqual([
      "0xa1",
      "0xa2",
      "0x1",
      ISSUED_AT_FELT,
      SIGNATURE.sig_r,
      SIGNATURE.sig_s,
    ]);
  });

  it("appends the Option::None tag when the prove response carries no signature", async () => {
    const proof: Proof = {
      data: "",
      output: ["0xclass", "0xa1"],
      proofFacts: [],
    };
    const result = await makeTransfers(proof).executeWithInvocation(invocationResult);
    expect(result.callAndProof.call.calldata).toEqual(["0xa1", "0x0"]);
  });
});
