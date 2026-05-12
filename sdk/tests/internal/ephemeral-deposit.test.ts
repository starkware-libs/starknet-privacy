/**
 * Tests for the ephemeral-account deposit flow (SNIP-9 outside execution dispatched via the
 * generic CallAnonymizer).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Signer, constants, hash, shortString, type Signature, type TypedData } from "starknet";

import { calculateEphemeralAddress } from "../../src/internal/ephemeral-deposit.js";
import {
  AUTO_DISCOVERY_ONLY,
  CALL_ANONYMIZER_ADDRESS,
  createTestEnv,
  MockTestEnv,
  POOL_ADDRESS,
} from "../helpers/test-fixtures.js";
import { toBigInt, toHex } from "../../src/utils/index.js";

const OZ_ACCOUNT_CLASS_HASH = "0x540d7f5ec7ecf317e68d48564934cb99259781b1ee3cedbbc37ec5337f8e688";

function chainIdSepoliaHex(): string {
  return shortString.encodeShortString("SN_SEPOLIA");
}

describe("calculateEphemeralAddress", () => {
  const classHash = OZ_ACCOUNT_CLASS_HASH;
  const publicKey = 0x1234abcd1234abcd1234abcd1234abcdn;

  it("unique=false: address matches calculateContractAddressFromHash with deployer=0", () => {
    const expected = hash.calculateContractAddressFromHash(7n, classHash, [publicKey], 0);
    const actual = calculateEphemeralAddress({
      classHash,
      constructorCalldata: [publicKey],
      salt: 7n,
    });
    expect(toBigInt(actual)).toBe(toBigInt(expected));
  });

  it("unique=true: address matches calculateContractAddressFromHash with pedersen(deployer, salt) and deployer=UDC", () => {
    const deployer = 0xdeadbeefn;
    const salt = 0x1234n;
    const mixedSalt = hash.computePedersenHash(toHex(deployer), toHex(salt));
    const expected = hash.calculateContractAddressFromHash(
      mixedSalt,
      classHash,
      [publicKey],
      constants.LegacyUDC.ADDRESS
    );
    const actual = calculateEphemeralAddress({
      classHash,
      constructorCalldata: [publicKey],
      salt,
      unique: true,
      deployerAddress: deployer,
    });
    expect(toBigInt(actual)).toBe(toBigInt(expected));
  });

  it("salt defaults to 0", () => {
    const expected = hash.calculateContractAddressFromHash(0n, classHash, [publicKey], 0);
    const actual = calculateEphemeralAddress({
      classHash,
      constructorCalldata: [publicKey],
    });
    expect(toBigInt(actual)).toBe(toBigInt(expected));
  });

  it("unique=true without deployerAddress throws", () => {
    expect(() =>
      calculateEphemeralAddress({
        classHash,
        constructorCalldata: [publicKey],
        unique: true,
      })
    ).toThrow(/deployerAddress is required/);
  });
});

describe("createEphemeralDeposit", () => {
  let testEnv: MockTestEnv;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  // Bootstrap: each test needs Alice registered + self-channel + ace-subchannel before
  // we can create an open note with depositor = A.
  async function bootstrapAlice() {
    const { mocknet, env, transfers } = testEnv;
    mocknet.executeOutside(await transfers.alice.build().register().execute());
    mocknet.executeOutside(
      await transfers.alice
        .build({ autoSetup: true })
        .setup(env.alice.address)
        .with(env.ace, (t) => t.setup(env.alice.address))
        .execute()
    );
  }

  function makeEphemeralSigner() {
    const privateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef";
    return { signer: new Signer(privateKey), privateKey };
  }

  it("returns a single apply_actions call (no deploy)", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const ephemeralAddress = `0x${"a".repeat(63)}1`;

    const result = await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: env.ace,
        amount: 100n,
        signer,
      },
      AUTO_DISCOVERY_ONLY
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].entrypoint).toBe("apply_actions");
    expect(result.proof).toBeDefined();
  });

  it("with `deploy`: still a single apply_actions call (UDC deploy is folded inside privacy_invoke)", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const classHash = OZ_ACCOUNT_CLASS_HASH;
    const constructorCalldata = [123n];
    const salt = 7n;
    const ephemeralAddress = calculateEphemeralAddress({
      classHash,
      constructorCalldata,
      salt,
    });

    const result = await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: env.ace,
        amount: 100n,
        signer,
        deploy: { classHash, constructorCalldata, salt },
      },
      AUTO_DISCOVERY_ONLY
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].entrypoint).toBe("apply_actions");
  });

  it("`deploy` with mismatching ephemeralAddress throws", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const classHash = OZ_ACCOUNT_CLASS_HASH;

    await expect(
      transfers.alice.createEphemeralDeposit(
        {
          ephemeralAddress: "0xdeadbeef",
          token: env.ace,
          amount: 100n,
          signer,
          deploy: { classHash, constructorCalldata: [123n], salt: 7n },
        },
        AUTO_DISCOVERY_ONLY
      )
    ).rejects.toThrow(/does not match address derived from `deploy`/);
  });

  it("signs SNIP-9 typed data with the ephemeral key, account = ephemeralAddress, version = V2", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const ephemeralAddress = `0x${"a".repeat(63)}1`;

    let observedTypedData: TypedData | undefined;
    let observedAccountAddress: string | undefined;
    const spySigner = {
      signMessage: vi.fn(
        async (typedData: TypedData, accountAddress: string): Promise<Signature> => {
          observedTypedData = typedData;
          observedAccountAddress = accountAddress;
          return signer.signMessage(typedData, accountAddress);
        }
      ),
    };

    await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: env.ace,
        amount: 100n,
        signer: spySigner,
        outsideExecution: { nonce: 0x99n },
      },
      AUTO_DISCOVERY_ONLY
    );

    expect(spySigner.signMessage).toHaveBeenCalledTimes(1);
    expect(toBigInt(observedAccountAddress!)).toBe(toBigInt(ephemeralAddress));
    expect(observedTypedData!.domain.name).toBe("Account.execute_from_outside");
    expect(observedTypedData!.domain.version).toBe("2");
    expect(observedTypedData!.domain.chainId).toBe(chainIdSepoliaHex());
  });

  it("inner calls are [token.approve(pool, amount), pool.deposit_to_open_note(note_id, token, amount)]", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const ephemeralAddress = `0x${"a".repeat(63)}1`;
    const amount = 100n;

    let observedTypedData: TypedData | undefined;
    const spySigner = {
      signMessage: async (typedData: TypedData, accountAddress: string): Promise<Signature> => {
        observedTypedData = typedData;
        return signer.signMessage(typedData, accountAddress);
      },
    };
    await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: env.ace,
        amount,
        signer: spySigner,
      },
      AUTO_DISCOVERY_ONLY
    );

    const message = observedTypedData!.message as Record<string, unknown>;
    const calls = message.Calls as { To: string; Selector: string }[];
    expect(calls).toHaveLength(2);
    expect(toBigInt(calls[0].To)).toBe(toBigInt(env.ace));
    expect(toBigInt(calls[0].Selector)).toBe(toBigInt(hash.getSelectorFromName("approve")));
    expect(toBigInt(calls[1].To)).toBe(toBigInt(POOL_ADDRESS));
    expect(toBigInt(calls[1].Selector)).toBe(
      toBigInt(hash.getSelectorFromName("deposit_to_open_note"))
    );
  });

  it("outsideExecution.caller defaults to the anonymizer; override propagates", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const ephemeralAddress = "0x1234567890abcdef1234567890abcdef1234567890abcdef1";
    const widerCaller = constants.OutsideExecutionCallerAny;

    let firstCallTypedData: TypedData | undefined;
    let secondCallTypedData: TypedData | undefined;
    const spy = (capture: (td: TypedData) => void) => ({
      signMessage: async (typedData: TypedData, accountAddress: string): Promise<Signature> => {
        capture(typedData);
        return signer.signMessage(typedData, accountAddress);
      },
    });

    await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: env.ace,
        amount: 100n,
        signer: spy((td) => (firstCallTypedData = td)),
      },
      AUTO_DISCOVERY_ONLY
    );
    await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: env.ace,
        amount: 100n,
        signer: spy((td) => (secondCallTypedData = td)),
        outsideExecution: { caller: widerCaller },
      },
      AUTO_DISCOVERY_ONLY
    );

    const callerOf = (td: TypedData | undefined) =>
      toBigInt((td!.message as Record<string, string>).Caller);
    expect(callerOf(firstCallTypedData)).toBe(toBigInt(CALL_ANONYMIZER_ADDRESS));
    expect(callerOf(secondCallTypedData)).toBe(toBigInt(widerCaller));
  });

  it("throws when callAnonymizerAddress is not configured", async () => {
    const { env, mocknet } = testEnv;
    const aliceWithoutAnonymizer = mocknet.createPrivateTransfers(
      env.alice.address,
      env.alice.privateKey
    );
    const { signer } = makeEphemeralSigner();
    const ephemeralAddress = `0x${"a".repeat(63)}1`;

    await expect(
      aliceWithoutAnonymizer.createEphemeralDeposit(
        {
          ephemeralAddress,
          token: env.ace,
          amount: 100n,
          signer,
        },
        AUTO_DISCOVERY_ONLY
      )
    ).rejects.toThrow(/callAnonymizerAddress must be set/);
  });
});
