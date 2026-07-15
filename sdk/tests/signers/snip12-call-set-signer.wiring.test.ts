import { describe, expect, it, vi } from "vitest";
import { ec, num, shortString, stark } from "starknet";
import { Mocknet } from "../../src/testing/mocknet.js";
import { createPrivateTransfers } from "../../src/factory.js";
import { MockProofProvider } from "../../src/testing/mock-proof-provider.js";
import { ContractDiscoveryProvider } from "../../src/internal/contract-discovery.js";
import { ProofInvocationFactory } from "../../src/internal/proof-invocation-factory.js";
import {
  Snip12CallSetSigner,
  computeCallSetHash,
} from "../../src/signers/snip12-call-set-signer.js";

const POOL_ADDRESS = 0x1n;

describe("Snip12CallSetSigner wiring", () => {
  it("flows through createPrivateTransfers and signs the CallSet over the compile_actions call", async () => {
    const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const env = mocknet.initialize();
    const poolHex = `0x${POOL_ADDRESS.toString(16)}`;
    const accountAddress = `0x${env.alice.address.toString(16)}`;
    const chainId = shortString.encodeShortString("SN_SEPOLIA");

    // Account signing key (independent of the viewing key).
    const privateKey = "0xa11ce5167";

    const signer = new Snip12CallSetSigner({
      accountAddress,
      chainId,
      sign: (h) => ec.starkCurve.sign(num.toHex(h), privateKey),
    });
    const signSpy = vi.spyOn(signer, "signTransaction");

    const transfers = createPrivateTransfers({
      account: { address: accountAddress, signer },
      viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
      proofInvocationFactory: new ProofInvocationFactory(),
      provingProvider: new MockProofProvider(mocknet.pool),
      discoveryProvider: new ContractDiscoveryProvider(mocknet.pool),
      poolContractAddress: poolHex,
    });

    const result = await transfers.build().register().createProofInvocation();

    // The adapter was invoked exactly once, with the single compile_actions call to the pool.
    expect(signSpy).toHaveBeenCalledOnce();
    const capturedCalls = signSpy.mock.calls[0][0];
    expect(capturedCalls).toHaveLength(1);
    expect(num.toHex(capturedCalls[0].contractAddress)).toBe(poolHex);
    expect(capturedCalls[0].entrypoint).toBe("compile_actions");

    // The invocation carries a raw 2-felt STARK signature (no smart-wallet wrapping) equal to the
    // account key signing the SNIP-12 CallSet hash of exactly those calls (RFC6979 deterministic).
    const signature = result.invocation.signature as string[];
    expect(signature).toHaveLength(2);
    const expectedHash = computeCallSetHash(accountAddress, capturedCalls, chainId);
    const expectedSig = stark.formatSignature(
      ec.starkCurve.sign(num.toHex(expectedHash), privateKey)
    );
    expect(signature).toEqual(expectedSig);
  });
});
