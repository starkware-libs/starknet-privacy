/**
 * Devnet integration tests for the ephemeral-account deposit flow (SNIP-9).
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { Signer } from "starknet";
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

  it("fresh ephemeral account: fund A, single tx (deploy + outside-exec) lands funds in Alice's note", async () => {
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

    expect(result.calls).toHaveLength(3);

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

    // Corrupt the signature on the outer (last) call. The signature pair
    // [r, s] is the tail of the calldata; replace with clearly invalid values.
    const calldata = result.calls[result.calls.length - 1].calldata as string[];
    calldata[calldata.length - 2] = "0x1";
    calldata[calldata.length - 1] = "0x1";

    await expect(
      devnet.executeOutside({ calls: result.calls, proof: result.proof })
    ).rejects.toThrow();
  });
});
