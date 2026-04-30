import { describe, expect, it, vi } from "vitest";
import type {
  Call,
  DeclareSignerDetails,
  DeployAccountSignerDetails,
  InvocationsSignerDetails,
  Signature,
  SignerInterface,
  TypedData,
} from "starknet";
import { stark } from "starknet";
import { Mocknet } from "../src/testing/mocknet.js";
import { createPrivateTransfers } from "../src/factory.js";
import { MockProofProvider } from "../src/testing/mock-proof-provider.js";
import { ContractDiscoveryProvider } from "../src/internal/contract-discovery.js";
import {
  ProofInvocationFactory,
  type ProofUser,
} from "../src/internal/proof-invocation-factory.js";
import type {
  ProofInvocation,
  ProofInvocationFactoryDetails,
  StarknetAddress,
} from "../src/interfaces.js";
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
    signMessage: (typedData: TypedData, accountAddress: string) =>
      delegate.signMessage(typedData, accountAddress),
    signTransaction,
    signDeclareTransaction: (details: DeclareSignerDetails) =>
      delegate.signDeclareTransaction(details),
    signDeployAccountTransaction: (details: DeployAccountSignerDetails) =>
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
    poolAddress: StarknetAddress,
    clientActions: ClientAction[],
    details: ProofInvocationFactoryDetails
  ): Promise<ProofInvocation> {
    this.capturedUsers.push(user);
    return super.create(user, poolAddress, clientActions, details);
  }
}

describe("proof invocation signing", () => {
  it("forwards user.signer to the proof invocation factory and signs at walletAddress = poolAddress", async () => {
    const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const env = mocknet.initialize();
    const poolHex = `0x${POOL_ADDRESS.toString(16)}`;

    // Use a real signer from starknet.js for correct ECDSA signing
    const { Signer } = await import("starknet");
    const rawSigner = new Signer("0x1234");

    // Wrap with a spy that adds a prefix (simulating Argent signature wrapping)
    const SIGNATURE_PREFIX = ["0x3", "0xdeadbeef"]; // e.g. [sig_count, signer_type]
    const wrappedSigner = createSpySigner(rawSigner, SIGNATURE_PREFIX);

    // Use the real ProofInvocationFactory (not mock) with a spy to capture the user
    const spyFactory = new SpyProofInvocationFactory();

    const transfers = createPrivateTransfers({
      account: {
        address: `0x${env.alice.address.toString(16)}`,
        signer: wrappedSigner,
      },
      viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
      proofInvocationFactory: spyFactory,
      provingProvider: new MockProofProvider(mocknet.pool),
      discoveryProvider: new ContractDiscoveryProvider(mocknet.pool),
      poolContractAddress: poolHex,
    });

    // Register to trigger a proof invocation
    const result = await transfers.build().register().createProofInvocation();

    // Factory received the wrapped signer directly — no Account needed.
    expect(spyFactory.capturedUsers).toHaveLength(1);
    expect(spyFactory.capturedUsers[0].signer).toBe(wrappedSigner);
    expect(spyFactory.capturedUsers[0].signer).not.toBe(rawSigner);

    // The wrapped signer was actually invoked for signing.
    expect(wrappedSigner.signTransaction).toHaveBeenCalledOnce();

    // Signed at walletAddress = poolAddress (so the pool, not the user, is the sender).
    const callArgs = (wrappedSigner.signTransaction as ReturnType<typeof vi.fn>).mock.calls[0];
    const details = callArgs[1] as InvocationsSignerDetails;
    expect(details.walletAddress).toBe(poolHex);

    // Resulting invocation signature carries the wrapping prefix — proof that
    // a smart-wallet-style custom signer can format the signature however it needs.
    const signature = result.invocation.signature as string[];
    expect(signature.length).toBeGreaterThan(2); // More than raw [r, s]
    expect(signature[0]).toBe(SIGNATURE_PREFIX[0]);
    expect(signature[1]).toBe(SIGNATURE_PREFIX[1]);
  });
});
