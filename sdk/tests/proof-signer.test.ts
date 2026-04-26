import { describe, expect, it, vi } from "vitest";
import type { Call, InvocationsSignerDetails, Signature, SignerInterface } from "starknet";
import { stark } from "starknet";
import { Mocknet } from "../src/testing/mocknet.js";
import { createPrivateTransfers } from "../src/factory.js";
import { MockProofProvider } from "../src/testing/mock-proof-provider.js";
import { ContractDiscoveryProvider } from "../src/internal/contract-discovery.js";
import {
  ProofInvocationFactory,
  type ProofUser,
} from "../src/internal/proof-invocation-factory.js";
import type { ProofInvocation, ProofInvocationFactoryDetails } from "../src/interfaces.js";
import type { ClientAction } from "../src/internal/client-actions.js";

const POOL_ADDRESS = 0x1n;

/**
 * A spy signer that records calls and delegates to another signer.
 * Simulates what a smart wallet would do: wrap the raw signature.
 */
function createSpySigner(delegate: SignerInterface, signaturePrefix: string[]): SignerInterface {
  const signTransaction = vi.fn(
    async (transactions: Call[], details: InvocationsSignerDetails): Promise<Signature> => {
      const rawSig = await delegate.signTransaction(transactions, details);
      // Simulate Argent-style wrapping: prepend extra data to the raw signature
      const formatted = stark.formatSignature(rawSig);
      return [...signaturePrefix, ...formatted];
    }
  );

  return {
    getPubKey: () => delegate.getPubKey(),
    signMessage: (typedData: any, accountAddress: string) =>
      delegate.signMessage(typedData, accountAddress),
    signTransaction,
    signDeclareTransaction: (details: any) => delegate.signDeclareTransaction(details),
    signDeployAccountTransaction: (details: any) =>
      delegate.signDeployAccountTransaction(details),
  } as SignerInterface;
}

/**
 * A custom ProofInvocationFactory that captures the signer used.
 * Delegates to the real factory but records the ProofUser for assertions.
 */
class SpyProofInvocationFactory extends ProofInvocationFactory {
  public capturedUsers: ProofUser[] = [];

  async create(
    user: ProofUser,
    poolAddress: any,
    clientActions: ClientAction[],
    details: ProofInvocationFactoryDetails
  ): Promise<ProofInvocation> {
    this.capturedUsers.push(user);
    return super.create(user, poolAddress, clientActions, details);
  }
}

describe("proofSigner", () => {
  it("uses proofSigner instead of account.signer when provided", () => {
    const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const env = mocknet.initialize();

    const accountSigner = { signTransaction: vi.fn() } as unknown as SignerInterface;
    const proofSigner = { signTransaction: vi.fn() } as unknown as SignerInterface;

    const account = {
      address: `0x${env.alice.address.toString(16)}`,
      signer: accountSigner,
    } as any;

    const transfers = createPrivateTransfers({
      account,
      viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
      proofSigner,
      provingProvider: new MockProofProvider(mocknet.pool),
      discoveryProvider: new ContractDiscoveryProvider(mocknet.pool),
      poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
    });

    // Verify the instance was created successfully
    expect(transfers).toBeDefined();
    expect(transfers.build).toBeDefined();
  });

  it("falls back to account.signer when proofSigner is not provided", () => {
    const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const env = mocknet.initialize();

    const account = {
      address: `0x${env.alice.address.toString(16)}`,
      signer: {} as SignerInterface,
    } as any;

    const transfers = createPrivateTransfers({
      account,
      viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
      // no proofSigner
      provingProvider: new MockProofProvider(mocknet.pool),
      discoveryProvider: new ContractDiscoveryProvider(mocknet.pool),
      poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
    });

    expect(transfers).toBeDefined();
  });

  it("proofSigner receives correct calls and details during proof invocation", async () => {
    const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const env = mocknet.initialize();
    const poolHex = `0x${POOL_ADDRESS.toString(16)}`;

    // Use a real signer from starknet.js for correct ECDSA signing
    const { Signer } = await import("starknet");
    const rawSigner = new Signer("0x1234");

    // Wrap with a spy that adds a prefix (simulating Argent signature wrapping)
    const SIGNATURE_PREFIX = ["0x3", "0xdeadbeef"]; // e.g. [sig_count, signer_type]
    const proofSigner = createSpySigner(rawSigner, SIGNATURE_PREFIX);

    // Use the real ProofInvocationFactory (not mock) with a spy to capture the user
    const spyFactory = new SpyProofInvocationFactory();

    const account = {
      address: `0x${env.alice.address.toString(16)}`,
      signer: rawSigner,
    } as any;

    const transfers = createPrivateTransfers({
      account,
      viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
      proofSigner,
      proofInvocationFactory: spyFactory,
      provingProvider: new MockProofProvider(mocknet.pool),
      discoveryProvider: new ContractDiscoveryProvider(mocknet.pool),
      poolContractAddress: poolHex,
    });

    // Register to trigger a proof invocation
    const result = await transfers.build().register().createProofInvocation();

    // Verify the spy factory received the proofSigner, not account.signer
    expect(spyFactory.capturedUsers).toHaveLength(1);
    expect(spyFactory.capturedUsers[0].signer).toBe(proofSigner);
    expect(spyFactory.capturedUsers[0].signer).not.toBe(rawSigner);

    // Verify the proofSigner.signTransaction was actually called
    expect(proofSigner.signTransaction).toHaveBeenCalledOnce();

    // Verify it was called with walletAddress = poolAddress (not user address)
    const callArgs = (proofSigner.signTransaction as ReturnType<typeof vi.fn>).mock.calls[0];
    const details = callArgs[1] as InvocationsSignerDetails;
    expect(details.walletAddress).toBe(poolHex);

    // Verify the resulting invocation signature contains the prefix (proof of wrapping)
    const signature = result.invocation.signature as string[];
    expect(signature.length).toBeGreaterThan(2); // More than raw [r, s]
    expect(signature[0]).toBe(SIGNATURE_PREFIX[0]);
    expect(signature[1]).toBe(SIGNATURE_PREFIX[1]);
  });

  it("account.signer is used for proof invocation when proofSigner is absent", async () => {
    const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const env = mocknet.initialize();
    const poolHex = `0x${POOL_ADDRESS.toString(16)}`;

    const { Signer } = await import("starknet");
    const rawSigner = new Signer("0x1234");
    const signTransactionSpy = vi.spyOn(rawSigner, "signTransaction");

    const spyFactory = new SpyProofInvocationFactory();

    const account = {
      address: `0x${env.alice.address.toString(16)}`,
      signer: rawSigner,
    } as any;

    const transfers = createPrivateTransfers({
      account,
      viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
      // no proofSigner
      proofInvocationFactory: spyFactory,
      provingProvider: new MockProofProvider(mocknet.pool),
      discoveryProvider: new ContractDiscoveryProvider(mocknet.pool),
      poolContractAddress: poolHex,
    });

    await transfers.build().register().createProofInvocation();

    // Verify the factory received account.signer (the raw one)
    expect(spyFactory.capturedUsers).toHaveLength(1);
    expect(spyFactory.capturedUsers[0].signer).toBe(rawSigner);

    // Verify account.signer.signTransaction was called
    expect(signTransactionSpy).toHaveBeenCalledOnce();

    // Verify signature is raw [r, s] — exactly 2 elements
    const callArgs = signTransactionSpy.mock.calls[0];
    const details = callArgs[1] as InvocationsSignerDetails;
    expect(details.walletAddress).toBe(poolHex);
  });
});
