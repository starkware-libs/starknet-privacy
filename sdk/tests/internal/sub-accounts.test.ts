/**
 * Tests for SubAccountsBuilder.invoke: it builds a `computeAndInvoke` against the anonymizer with
 * `computeAdditionalData = [dappName, nonce]` and `invokeAdditionalData` compiled from the dapp calls via the anonymizer
 * ABI. The MockPoolContract simulate flow forwards these to the target's `privacy_compute` /
 * `privacy_invoke_with_computation`, mirroring Cairo.
 */
import { describe, expect, it } from "vitest";
import { CallData, hash, shortString } from "starknet";
import { Mocknet } from "../../src/testing/mocknet.js";
import { MockContract } from "../../src/testing/contracts.js";
import { compute_identity_key } from "../../src/utils/hashes.js";
import { hash as poseidonHash } from "../../src/utils/crypto.js";
import { SubAccountAnonymizerABI } from "../../src/internal/anonymizer-abi.js";
import { toBigInt } from "../../src/utils/index.js";
import { Open, StarknetAddress, type CollectPolicy } from "../../src/interfaces.js";

const COMPUTED_MARKER = 0xc0ffeen;
const ANONYMIZER = "0xab0a";

class MockComputeContract implements MockContract {
  [key: string]: unknown;
  public computeCalls: bigint[][] = [];
  public invokeCalls: bigint[][] = [];

  constructor(public address: StarknetAddress) {}

  // MockContracts.call spreads the flat calldata span as positional args.
  privacy_compute(...calldata: bigint[]): bigint {
    this.computeCalls.push(calldata);
    return COMPUTED_MARKER;
  }

  privacy_invoke_with_computation(...calldata: bigint[]): void {
    this.invokeCalls.push(calldata);
  }
}

describe("SubAccountsBuilder.invoke", () => {
  it("queues a computeAndInvoke with [dappName, nonce] and ABI-compiled calls", async () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const anonymizer = new MockComputeContract(ANONYMIZER);
    mocknet.contracts.register(anonymizer);

    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
      subAccountAnonymizerAddress: ANONYMIZER,
    });
    mocknet.executeOutside(await transfers.build().register().execute());

    const dappName = "DAPP";
    const nonce = 3n;
    const calls = [{ contractAddress: "0xda99", entrypoint: "pay_out", calldata: [0x1234n, 0n] }];
    mocknet.executeOutside(
      await transfers.build().subaccounts(dappName).invoke(nonce, { calls }).execute()
    );

    const identityKey = compute_identity_key(
      toBigInt(env.alice.address),
      toBigInt(env.alice.privateKey),
      toBigInt(ANONYMIZER)
    );
    const dappFelt = toBigInt(shortString.encodeShortString(dappName));
    expect(anonymizer.computeCalls).toEqual([[identityKey, dappFelt, nonce]]);

    // No open note was created, so open_notes is empty and invokeAdditionalData is fully determined by calls.
    const expectedInvokeData = new CallData(SubAccountAnonymizerABI)
      .compile("privacy_invoke_with_computation", [
        0n,
        [
          {
            to: "0xda99",
            selector: hash.getSelectorFromName("pay_out"),
            calldata: CallData.compile([0x1234n, 0n]),
          },
        ],
        [],
      ])
      .slice(1)
      .map(toBigInt);
    expect(anonymizer.invokeCalls).toEqual([[COMPUTED_MARKER, ...expectedInvokeData]]);
  });

  it("encodes each settled open note's collect_policy (all / diff / exact), defaulting to all", async () => {
    const dappName = "DAPP";
    const calls = [{ contractAddress: "0xda99", entrypoint: "pay_out", calldata: [0x1234n, 0n] }];
    const EXACT_AMOUNT = 0x9999n;
    const options = {
      autoRegister: true,
      autoDiscover: { channels: "refresh" as const, notes: "refresh" as const },
      autoSetup: true,
    };

    // Fresh net per run: the single settled open note lands at the same index (so the same note_id)
    // every time, leaving `collect_policy` as the only thing that varies between runs.
    async function invokeWithOpenNote(collectPolicy?: CollectPolicy): Promise<bigint[]> {
      const mocknet = new Mocknet({ poolAddress: 0x1n });
      const env = mocknet.initialize();
      const anonymizer = new MockComputeContract(ANONYMIZER);
      mocknet.contracts.register(anonymizer);
      const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
        subAccountAnonymizerAddress: ANONYMIZER,
      });
      const token = toBigInt(env.ace);

      mocknet.executeOutside(await transfers.build(options).register().execute());
      mocknet.executeOutside(
        await transfers
          .build(options)
          .with(token)
          .transfer({ recipient: env.alice.address, amount: Open })
          .done()
          .subaccounts(dappName)
          .invoke(1n, { calls, collectPolicy })
          .execute()
      );
      const invoke = anonymizer.invokeCalls[0];
      if (!invoke) throw new Error("expected one invoke call");
      return invoke;
    }

    const all = await invokeWithOpenNote({ type: "all" });
    const diff = await invokeWithOpenNote({ type: "diff" });
    const exact = await invokeWithOpenNote({ type: "exact", amount: EXACT_AMOUNT });
    const byDefault = await invokeWithOpenNote();

    // Each policy encodes differently on the (identically-derived) open note.
    expect(all).not.toEqual(diff);
    expect(all).not.toEqual(exact);
    expect(diff).not.toEqual(exact);
    // Only the `exact` variant carries its amount into the calldata.
    expect(exact).toContain(EXACT_AMOUNT);
    expect(all).not.toContain(EXACT_AMOUNT);
    expect(diff).not.toContain(EXACT_AMOUNT);
    // Omitting collectPolicy is equivalent to `{ type: "all" }`.
    expect(byDefault).toEqual(all);
  });

  it("encodes a felt dapp name equivalently to its short-string form", async () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const anonymizer = new MockComputeContract(ANONYMIZER);
    mocknet.contracts.register(anonymizer);
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
      subAccountAnonymizerAddress: ANONYMIZER,
    });
    mocknet.executeOutside(await transfers.build().register().execute());

    const dappFelt = toBigInt(shortString.encodeShortString("DAPP"));
    mocknet.executeOutside(
      await transfers.build().subaccounts(dappFelt).invoke(0n, { calls: [] }).execute()
    );

    expect(anonymizer.computeCalls[0]?.slice(1)).toEqual([dappFelt, 0n]);
  });

  it("throws when sub-account config is missing", () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey);
    expect(() => transfers.build().subaccounts("DAPP")).toThrow(/subAccountAnonymizerAddress/);
  });
});

describe("SubAccountsBuilder commitments", () => {
  it("derives partialCommitment = hash(identity_key, dappName) locally", async () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
      subAccountAnonymizerAddress: ANONYMIZER,
    });

    const identityKey = compute_identity_key(
      toBigInt(env.alice.address),
      toBigInt(env.alice.privateKey),
      toBigInt(ANONYMIZER)
    );
    const partialCommitment = poseidonHash(
      identityKey,
      toBigInt(shortString.encodeShortString("DAPP"))
    );

    await expect(transfers.build().subaccounts("DAPP").partialCommitment()).resolves.toBe(
      partialCommitment
    );
  });

  it("derives commitment = hash(partialCommitment, nonce) locally", async () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
      subAccountAnonymizerAddress: ANONYMIZER,
    });

    const identityKey = compute_identity_key(
      toBigInt(env.alice.address),
      toBigInt(env.alice.privateKey),
      toBigInt(ANONYMIZER)
    );
    const partialCommitment = poseidonHash(
      identityKey,
      toBigInt(shortString.encodeShortString("DAPP"))
    );

    await expect(transfers.build().subaccounts("DAPP").commitment(7n)).resolves.toBe(
      poseidonHash(partialCommitment, 7n)
    );
  });

  it("uses felt dapp names for local commitment derivation", async () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
      subAccountAnonymizerAddress: ANONYMIZER,
    });

    const dappFelt = toBigInt(shortString.encodeShortString("DAPP"));
    await expect(transfers.build().subaccounts(dappFelt).partialCommitment()).resolves.toBe(
      await transfers.build().subaccounts("DAPP").partialCommitment()
    );
  });
});
