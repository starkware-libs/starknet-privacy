/**
 * Tests for SubAccountsBuilder.invoke: it builds a `computeAndInvoke` against the anonymizer with
 * `computeAdditionalData = [dappName, nonce]` and `invokeAdditionalData` compiled from the dapp calls via the anonymizer
 * ABI. The MockPoolContract simulate flow forwards these to the target's `privacy_compute` /
 * `privacy_invoke_with_computation`, mirroring Cairo.
 */
import { describe, expect, it, vi } from "vitest";
import { CallData, hash, shortString } from "starknet";
import { Mocknet } from "../../src/testing/mocknet.js";
import { MockContract } from "../../src/testing/contracts.js";
import { compute_identity_key } from "../../src/utils/hashes.js";
import { hash as poseidonHash } from "../../src/utils/crypto.js";
import { SubAccountAnonymizerABI } from "../../src/internal/anonymizer-abi.js";
import { toBigInt } from "../../src/utils/index.js";
import { StarknetAddress, SubAccount } from "../../src/interfaces.js";

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
      await transfers.subaccounts(dappName).invoke(nonce, { calls }).execute()
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
      await transfers.subaccounts(dappFelt).invoke(0n, { calls: [] }).execute()
    );

    expect(anonymizer.computeCalls[0]?.slice(1)).toEqual([dappFelt, 0n]);
  });

  it("throws when sub-account config is missing", () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey);
    expect(() => transfers.subaccounts("DAPP")).toThrow(/subAccountAnonymizerAddress/);
  });
});

describe("SubAccountsBuilder.identify", () => {
  const RESOLVED_SUB_ACCOUNTS: SubAccount[] = [
    { nonce: 0, address: 0x5a10n, isDeployed: true },
    { nonce: 1, address: 0x5a11n, isDeployed: false },
  ];

  it("derives partial_commitment = hash(identity_key, dappName) and passes the nonce range", async () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const getSubAccounts = vi.fn().mockResolvedValue({ subAccounts: RESOLVED_SUB_ACCOUNTS });
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
      subAccountAnonymizerAddress: ANONYMIZER,
      getSubAccounts,
    });

    const result = await transfers.subaccounts("DAPP").identify(0, 8);

    expect(result).toEqual(RESOLVED_SUB_ACCOUNTS);
    const identityKey = compute_identity_key(
      toBigInt(env.alice.address),
      toBigInt(env.alice.privateKey),
      toBigInt(ANONYMIZER)
    );
    const partialCommitment = poseidonHash(
      identityKey,
      toBigInt(shortString.encodeShortString("DAPP"))
    );
    expect(getSubAccounts).toHaveBeenCalledWith(toBigInt(env.alice.address), env.alice.privateKey, {
      anonymizerAddress: toBigInt(ANONYMIZER),
      partialCommitment,
      startNonce: 0,
      endNonce: 8,
    });
  });

  it("defaults endNonce to startNonce + 1 (single-nonce lookup)", async () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    const getSubAccounts = vi.fn().mockResolvedValue({ subAccounts: RESOLVED_SUB_ACCOUNTS });
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
      subAccountAnonymizerAddress: ANONYMIZER,
      getSubAccounts,
    });

    await transfers.subaccounts("DAPP").identify(3);

    expect(getSubAccounts).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ startNonce: 3, endNonce: 4 })
    );
  });

  it("throws when the discovery provider cannot resolve sub-accounts", async () => {
    const mocknet = new Mocknet({ poolAddress: 0x1n });
    const env = mocknet.initialize();
    // No getSubAccounts resolver: the mock pool's ContractDiscoveryProvider has no anonymizer view.
    const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey, {
      subAccountAnonymizerAddress: ANONYMIZER,
    });

    await expect(transfers.subaccounts("DAPP").identify(0)).rejects.toThrow(/sub-accounts/);
  });
});
