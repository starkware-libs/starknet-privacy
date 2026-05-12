/**
 * Devnet integration tests for the ephemeral-account deposit flow (SNIP-9 via the
 * EphemeralDepositAnonymizer).
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { Signer, type Signature, type TypedData } from "starknet";
import { Devnet, createDevnetTestEnv, type DevnetTestEnv } from "../src/testing/index.js";
import { calculateEphemeralAddress } from "../src/internal/ephemeral-deposit.js";

// Standard OpenZeppelin Account class, pre-declared on the devnet image. OZ
// `AccountComponent` ships SNIP-9 `execute_from_outside_v2`.
const OZ_ACCOUNT_CLASS_HASH = "0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564";

describe("Ephemeral-account deposit (SNIP-9) on devnet", () => {
  let devnet: Devnet;
  let env: DevnetTestEnv;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createDevnetTestEnv(devnet);
  });

  afterAll(async () => {
    await devnet?.cleanup();
  });

  it("fresh ephemeral account: fund A, single tx (deploy + apply_actions) lands funds in Alice's note", async () => {
    const { env: de, transfers } = env;
    const amount = 100n;

    // Register Alice and set up her STRK self-channel.
    const setup = await transfers.alice
      .build({ autoSetup: true })
      .register()
      .with(de.strk, (t) => t.setup(de.alice.address))
      .execute();
    await devnet.executeOutside(setup.callAndProof);

    // Pick a fresh ephemeral keypair and derive its address.
    const ephemeralPrivateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef";
    const ephemeralSigner = new Signer(ephemeralPrivateKey);
    const ephemeralPublicKey = await ephemeralSigner.getPubKey();
    const ephemeralAddress = calculateEphemeralAddress({
      classHash: OZ_ACCOUNT_CLASS_HASH,
      constructorCalldata: [ephemeralPublicKey],
      salt: ephemeralPublicKey,
    });

    // External "depositor" funds the ephemeral address (out-of-scope step, simulated
    // here with an admin STRK transfer).
    await de.admin.execute({
      contractAddress: de.strk,
      entrypoint: "transfer",
      calldata: [ephemeralAddress, amount, 0n],
    });

    // Alice builds the deposit bundle.
    const result = await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: de.strk,
        amount,
        signer: ephemeralSigner,
        deploy: {
          classHash: OZ_ACCOUNT_CLASS_HASH,
          constructorCalldata: [ephemeralPublicKey],
          salt: ephemeralPublicKey,
        },
      },
      { autoDiscover: { channels: "refresh", notes: "refresh" } }
    );

    // Single outer call: apply_actions. UDC deploy + A.execute_from_outside_v2 are dispatched
    // by the CallAnonymizer inside the InvokeExternal action of apply_actions.
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].entrypoint).toBe("apply_actions");

    // Submit via admin's SNIP-9 outside execution (paymaster pattern). Alice's
    // account never appears as the on-chain tx sender.
    const receipt = await devnet.executeOutside({
      calls: result.calls,
      proof: result.proof,
    });
    expect(receipt.isSuccess()).toBe(true);

    // Alice should now discover a STRK note for `amount`.
    const { notes } = await transfers.alice.discoverNotes();
    const strkNotes = notes.get(BigInt(de.strk)) ?? [];
    const filled = strkNotes.find((n) => n.amount === amount);
    expect(filled).toBeDefined();
  });

  it("tampered signature: outside-execution validation rejects the tx", async () => {
    const { env: de, transfers } = env;
    const amount = 100n;

    const ephemeralPrivateKey = "0x0fedcba9876543210fedcba9876543210fedcba987654321";
    const ephemeralSigner = new Signer(ephemeralPrivateKey);
    const ephemeralPublicKey = await ephemeralSigner.getPubKey();
    const ephemeralAddress = calculateEphemeralAddress({
      classHash: OZ_ACCOUNT_CLASS_HASH,
      constructorCalldata: [ephemeralPublicKey],
      salt: ephemeralPublicKey,
    });

    await de.admin.execute({
      contractAddress: de.strk,
      entrypoint: "transfer",
      calldata: [ephemeralAddress, amount, 0n],
    });

    // Use a signer that returns a clearly invalid (r, s) so the on-chain SNIP-9 verifier
    // inside the OZ account rejects when the anonymizer forwards. The signature lives inside
    // the apply_actions calldata via the privacy_invoke arg, so post-build tampering would be
    // brittle; injecting at sign time is the most direct path.
    const badSigner = {
      signMessage: async (_typedData: TypedData, _accountAddress: string): Promise<Signature> => [
        "0x1",
        "0x1",
      ],
    };

    const result = await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: de.strk,
        amount,
        signer: badSigner,
        deploy: {
          classHash: OZ_ACCOUNT_CLASS_HASH,
          constructorCalldata: [ephemeralPublicKey],
          salt: ephemeralPublicKey,
        },
      },
      { autoDiscover: { channels: "refresh", notes: "refresh" } }
    );

    await expect(
      devnet.executeOutside({ calls: result.calls, proof: result.proof })
    ).rejects.toThrow();
  });
});
