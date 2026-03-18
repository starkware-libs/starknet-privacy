import { describe, expect, it, beforeEach } from "vitest";
import { createTestEnv, AUTO_ALL, MockTestEnv, POOL_ADDRESS } from "../../helpers/test-fixtures.js";
import type { FeeSchedule } from "../../../src/interfaces.js";
import { MockFeeProvider } from "../../../src/testing/mock-fee-provider.js";
import { Mocknet } from "../../../src/testing/mocknet.js";
import { toBigInt } from "../../../src/utils/index.js";

const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  feeRecipient: "0xfee",
  baseFee: "1",
  perAction: {
    writeOnce: "1",
    append: "1",
    transferFrom: "1",
    transferTo: "1",
    emitViewingKeySet: "1",
    emitWithdrawal: "1",
    emitDeposit: "1",
    emitOpenNoteCreated: "1",
    emitEncNoteCreated: "1",
    emitNoteUsed: "1",
    invoke: {},
  },
  gasPrice: "1",
  validUntil: Math.floor(Date.now() / 1000) + 600,
};

describe("Paymaster Integration", () => {
  let testEnv: MockTestEnv;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  it("autoPaymaster: true without feeProvider throws", async () => {
    const { transfers, env } = testEnv;
    const { alice } = transfers;

    await expect(
      alice
        .build({ ...AUTO_ALL, autoPaymaster: true })
        .with(env.ace)
        .deposit({ amount: 100n })
        .execute()
    ).rejects.toThrow(/feeProvider/);
  });

  it("autoPaymaster: false does not call feeProvider", async () => {
    const { transfers, env } = testEnv;
    const { alice } = transfers;

    const result = await alice
      .build({ ...AUTO_ALL, autoPaymaster: false })
      .with(env.ace)
      .deposit({ amount: 100n })
      .execute();

    expect(result.callAndProof).toBeDefined();
  });

  it("preview returns actions and zero fee when autoPaymaster is disabled", async () => {
    const { transfers, env } = testEnv;
    const { alice } = transfers;

    const result = await alice
      .build({ ...AUTO_ALL, autoPaymaster: false })
      .with(env.ace)
      .deposit({ amount: 100n })
      .preview();

    expect(result.fee).toBe(0n);
    expect(result.feeSchedule).toBeUndefined();
    expect(result.actions.deposits).toHaveLength(1);
    expect(result.actions.deposits![0].amount).toBe(100n);
  });

  it("preview returns actions and estimated fee when autoPaymaster is enabled", async () => {
    const mockFeeProvider = new MockFeeProvider(DEFAULT_FEE_SCHEDULE);
    const paymasterMocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const paymasterEnv = paymasterMocknet.initialize();

    const alicePaymaster = paymasterMocknet.createPrivateTransfers(
      paymasterEnv.alice.address,
      paymasterEnv.alice.privateKey,
      { feeProvider: mockFeeProvider }
    );

    const result = await alicePaymaster
      .build({
        ...AUTO_ALL,
        autoPaymaster: true,
        paymasterFeeToken: paymasterEnv.ace,
      })
      .with(paymasterEnv.ace)
      .deposit({ amount: 100n })
      .preview();

    expect(result.fee).toBeGreaterThan(0n);
    expect(result.feeSchedule).toEqual(DEFAULT_FEE_SCHEDULE);
    // preview does NOT mutate actions.withdraws (no fee withdrawal injected)
    expect(result.actions.withdraws).toHaveLength(0);
    expect(mockFeeProvider.calls).toHaveLength(1);
    expect(mockFeeProvider.calls[0].method).toBe("getFeeQuote");
  });

  it("autoPaymaster injects fee withdrawal and returns callAndProof without submitting", async () => {
    const mockFeeProvider = new MockFeeProvider(DEFAULT_FEE_SCHEDULE);

    const paymasterMocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
    const paymasterEnv = paymasterMocknet.initialize();
    const aceToken = toBigInt(paymasterEnv.ace);

    // Create a standard transfers instance (no paymaster) for initial deposit
    const aliceStandard = paymasterMocknet.createPrivateTransfers(
      paymasterEnv.alice.address,
      paymasterEnv.alice.privateKey
    );

    // Step 1: Deposit 100 ace (without paymaster) to establish notes
    const depositResult = await aliceStandard
      .build(AUTO_ALL)
      .with(paymasterEnv.ace)
      .deposit({ amount: 100n })
      .execute();
    paymasterMocknet.executeOutside(depositResult);

    const aliceNotes = depositResult.registry.notes.get(aceToken) ?? [];
    expect(aliceNotes.length).toBe(1);
    expect(aliceNotes[0].amount).toBe(100n);

    // Step 2: Create a paymaster-enabled transfers instance
    const alicePaymaster = paymasterMocknet.createPrivateTransfers(
      paymasterEnv.alice.address,
      paymasterEnv.alice.privateKey,
      { feeProvider: mockFeeProvider }
    );

    // Step 3: Withdraw with autoPaymaster — fee withdrawal injected automatically
    const result = await alicePaymaster
      .build({
        ...AUTO_ALL,
        autoPaymaster: true,
        paymasterFeeToken: paymasterEnv.ace,
        registry: depositResult.registry,
      })
      .surplusTo(paymasterEnv.alice.address)
      .with(paymasterEnv.ace)
      .withdraw({ amount: 10n })
      .execute();

    // Should have called getFeeQuote only (no executeTransaction — execute() doesn't submit)
    expect(mockFeeProvider.calls.length).toBe(1);
    expect(mockFeeProvider.calls[0].method).toBe("getFeeQuote");

    // callAndProof is returned as usual — caller submits to paymaster separately
    expect(result.callAndProof).toBeDefined();
    expect(result.callAndProof.call.entrypoint).toBe("apply_actions");
    expect(result.callAndProof.proof).toBeDefined();
  });
});
