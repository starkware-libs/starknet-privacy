/**
 * Tests for the ephemeral-account deposit flow (SNIP-9 outside execution).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallData,
  Signer,
  constants,
  hash,
  num,
  outsideExecution as snip9,
  OutsideExecutionVersion,
  shortString,
  uint256,
  type Call,
  type Signature,
  type TypedData,
} from "starknet";

import { calculateEphemeralAddress } from "../../src/internal/ephemeral-deposit.js";
import {
  AUTO_DISCOVERY_ONLY,
  createTestEnv,
  MockTestEnv,
  POOL_ADDRESS,
} from "../helpers/test-fixtures.js";
import { toBigInt, toHex } from "../../src/utils/index.js";

const OZ_ACCOUNT_CLASS_HASH = "0x540d7f5ec7ecf317e68d48564934cb99259781b1ee3cedbbc37ec5337f8e688";

// Encoded constant SNIP-9 "ANY_CALLER" value from starknet.js constants module.
const ANY_CALLER = constants.OutsideExecutionCallerAny;

function chainIdSepoliaHex(): string {
  // Same encoding rules as starknet.js getTypedData uses for the domain.
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

  // Pick a fresh keypair for each call so test isolation is clean.
  function makeEphemeralSigner() {
    const privateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef"; // < curve order
    const signer = new Signer(privateKey);
    return { signer, privateKey };
  }

  it("no `deploy`: returns 2 calls (apply_actions, execute_from_outside_v2)", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    // A is opaque to the SDK; we just need a stable felt for the depositor.
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

    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].entrypoint).toBe("apply_actions");
    expect(toBigInt(result.calls[0].contractAddress)).toBe(toBigInt(POOL_ADDRESS));
    expect(result.calls[1].entrypoint).toBe("execute_from_outside_v2");
    expect(toBigInt(result.calls[1].contractAddress)).toBe(toBigInt(ephemeralAddress));
    expect(result.noteId).toBeTypeOf("bigint");
    expect(result.proof).toBeDefined();
  });

  it("with `deploy`: returns 3 calls and middle call is UDC.deployContract", async () => {
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

    expect(result.calls).toHaveLength(3);
    expect(result.calls[0].entrypoint).toBe("apply_actions");
    expect(result.calls[1].entrypoint).toBe(constants.LegacyUDC.ENTRYPOINT);
    expect(toBigInt(result.calls[1].contractAddress)).toBe(toBigInt(constants.LegacyUDC.ADDRESS));
    expect(result.calls[2].entrypoint).toBe("execute_from_outside_v2");
    expect(toBigInt(result.calls[2].contractAddress)).toBe(toBigInt(ephemeralAddress));
  });

  it("UDC deploy calldata matches [classHash, salt, unique?, constructorCalldata]", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const classHash = OZ_ACCOUNT_CLASS_HASH;
    const constructorCalldata = [123n, 456n];
    const salt = 42n;
    const ephemeralAddress = calculateEphemeralAddress({
      classHash,
      constructorCalldata,
      salt,
    });

    const result = await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: env.ace,
        amount: 50n,
        signer,
        deploy: { classHash, constructorCalldata, salt },
      },
      AUTO_DISCOVERY_ONLY
    );

    const expected = CallData.compile([classHash, salt, 0n, constructorCalldata]);
    expect(result.calls[1].calldata).toEqual(expected);
  });

  it("`deploy` with mismatching ephemeralAddress throws", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const classHash = OZ_ACCOUNT_CLASS_HASH;

    await expect(
      transfers.alice.createEphemeralDeposit(
        {
          ephemeralAddress: "0xdeadbeef", // arbitrary mismatch
          token: env.ace,
          amount: 100n,
          signer,
          deploy: { classHash, constructorCalldata: [123n], salt: 7n },
        },
        AUTO_DISCOVERY_ONLY
      )
    ).rejects.toThrow(/does not match address derived from `deploy`/);
  });

  it("signs the SNIP-9 typed data with the ephemeral key and returns the same hash as starknet.js", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const ephemeralAddress = `0x${"a".repeat(63)}1`;

    // Capture the typedData the SDK passes to signMessage.
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
    const nonce = 0x99n; // fix for reproducibility

    const result = await transfers.alice.createEphemeralDeposit(
      {
        ephemeralAddress,
        token: env.ace,
        amount: 100n,
        signer: spySigner,
        outsideExecution: { nonce },
      },
      AUTO_DISCOVERY_ONLY
    );

    expect(spySigner.signMessage).toHaveBeenCalledTimes(1);
    expect(toBigInt(observedAccountAddress!)).toBe(toBigInt(ephemeralAddress));

    // Reconstruct the typed data manually and compare hashes.
    const tokenHex = toHex(env.ace);
    const approveCall: Call = {
      contractAddress: tokenHex,
      entrypoint: "approve",
      calldata: CallData.compile([toHex(POOL_ADDRESS), uint256.bnToUint256(100n)]),
    };
    const depositCall: Call = {
      contractAddress: toHex(POOL_ADDRESS),
      entrypoint: "deposit_to_open_note",
      calldata: CallData.compile([result.noteId, env.ace, 100n]),
    };
    const expectedTypedData = snip9.getTypedData(
      chainIdSepoliaHex() as constants.StarknetChainId,
      { caller: ANY_CALLER, execute_after: 0n, execute_before: 2n ** 64n - 1n },
      nonce,
      [approveCall, depositCall],
      OutsideExecutionVersion.V2
    );
    expect(observedTypedData).toEqual(expectedTypedData);
  });

  it("outsideExecution.caller defaults to ANY_CALLER; override propagates", async () => {
    const { env, transfers } = testEnv;
    await bootstrapAlice();
    const { signer } = makeEphemeralSigner();
    const ephemeralAddress = "0x1234567890abcdef1234567890abcdef1234567890abcdef1";
    const restrictedCaller = "0x5555555555555555555555555555555555555555555555552";

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
        outsideExecution: { caller: restrictedCaller },
      },
      AUTO_DISCOVERY_ONLY
    );

    const callerOf = (td: TypedData | undefined) =>
      toBigInt((td!.message as Record<string, string>).Caller);
    expect(callerOf(firstCallTypedData)).toBe(toBigInt(ANY_CALLER));
    expect(callerOf(secondCallTypedData)).toBe(toBigInt(restrictedCaller));
  });

  it("reuses the openNoteId from executeWithInvocation in the inner deposit call", async () => {
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

    // The outer calldata to execute_from_outside_v2 carries the inner deposit_to_open_note
    // call. The selector and the noteId felt must both appear in it.
    const depositSelector = hash.getSelectorFromName("deposit_to_open_note");
    const outer = result.calls[result.calls.length - 1].calldata as string[];
    expect(outer.some((c) => num.toBigInt(c) === num.toBigInt(depositSelector))).toBe(true);
    expect(outer.some((c) => num.toBigInt(c) === toBigInt(result.noteId))).toBe(true);
  });
});
