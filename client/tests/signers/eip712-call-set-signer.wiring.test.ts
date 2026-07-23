import { describe, expect, it, vi } from "vitest";
import { num, stark } from "starknet";
import { Mocknet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import { MockProofProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import { ContractDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  Eip712HashSigner,
  computeCallSet712Hash,
  secp256k1SignFn,
} from "../../src/signers/eip712-call-set-signer.js";

const POOL_ADDRESS = 0x1n;

describe("Eip712HashSigner wiring", () => {
  it("flows through createPrivateTransfers and emits the 6-felt CallSet signature", async () => {
    const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const env = mocknet.initialize();
    const poolHex = `0x${POOL_ADDRESS.toString(16)}`;
    const accountAddress = `0x${env.alice.address.toString(16)}`;
    const snChainName = "SN_SEPOLIA";
    const evmChainId = 1n;
    const evmPrivateKey = 0xc0ffeen;

    const signer = new Eip712HashSigner({
      accountAddress,
      snChainName,
      evmChainId,
      sign: secp256k1SignFn(evmPrivateKey),
    });
    const signSpy = vi.spyOn(signer, "signTransaction");

    const transfers = createPrivateTransfers({
      account: { address: accountAddress, signer },
      viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
      provingProvider: new MockProofProvider(mocknet.pool),
      discoveryProvider: new ContractDiscoveryProvider(mocknet.pool),
      poolContractAddress: poolHex,
    });

    const result = await transfers.build().register().createProofInvocation();

    expect(signSpy).toHaveBeenCalledOnce();
    const capturedCalls = signSpy.mock.calls[0][0];
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].entrypoint).toBe("compile_actions");

    // The invocation carries the 6-felt EIP-712 signature [r_hi,r_lo,s_hi,s_lo,v,evm_chain_id] equal
    // to the account key signing the EIP-712 CallSet hash of exactly those calls (RFC6979 det.).
    const signature = result.invocation.signature as string[];
    expect(signature).toHaveLength(6);
    expect(num.toBigInt(signature[5])).toBe(evmChainId);

    const expectedHash = computeCallSet712Hash(
      accountAddress,
      capturedCalls,
      snChainName,
      evmChainId
    );
    const { r, s, v } = await secp256k1SignFn(evmPrivateKey)(expectedHash);
    const expected = stark.formatSignature([
      num.toHex(r >> 128n),
      num.toHex(r & ((1n << 128n) - 1n)),
      num.toHex(s >> 128n),
      num.toHex(s & ((1n << 128n) - 1n)),
      num.toHex(BigInt(v)),
      num.toHex(evmChainId),
    ]);
    expect(signature).toEqual(expected);
  });
});
