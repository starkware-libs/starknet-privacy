import { describe, expect, it } from "vitest";
import {
  estimatePaymasterFee,
  estimateServerActionCounts,
} from "../../../src/internal/paymaster/fee-estimator.js";
import type { Actions, FeeSchedule, Note } from "../../../src/interfaces.js";
import { Witness } from "../../../src/interfaces.js";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 1n,
    amount: 100n,
    witness: new Witness(0n, 0, 0n),
    sender: 0x1n,
    ...overrides,
  };
}

const UNIFORM_FEE_SCHEDULE: FeeSchedule = {
  feeRecipient: "0xfee",
  baseFee: "1000",
  perAction: {
    writeOnce: "100",
    append: "100",
    transferFrom: "100",
    transferTo: "100",
    emitViewingKeySet: "100",
    emitWithdrawal: "100",
    emitDeposit: "100",
    emitOpenNoteCreated: "100",
    emitEncNoteCreated: "100",
    emitNoteUsed: "100",
    invoke: { "0xbeef": "500" },
  },
  gasPrice: "10",
  validUntil: Math.floor(Date.now() / 1000) + 600,
};

describe("estimateServerActionCounts", () => {
  it("empty actions produce only fee withdrawal cost", () => {
    const counts = estimateServerActionCounts({}, false);

    // Fee withdrawal itself: +1 TransferTo + +1 EmitWithdrawal
    expect(counts.transferTo).toBe(1);
    expect(counts.emitWithdrawal).toBe(1);
    // Everything else zero
    expect(counts.writeOnce).toBe(0);
    expect(counts.append).toBe(0);
    expect(counts.transferFrom).toBe(0);
    expect(counts.emitViewingKeySet).toBe(0);
    expect(counts.emitDeposit).toBe(0);
    expect(counts.emitOpenNoteCreated).toBe(0);
    expect(counts.emitEncNoteCreated).toBe(0);
    expect(counts.emitNoteUsed).toBe(0);
  });

  it("SetViewingKey produces 2 WriteOnce + 1 EmitViewingKeySet", () => {
    const counts = estimateServerActionCounts({ setViewingKey: {} }, false);

    expect(counts.writeOnce).toBe(2);
    expect(counts.emitViewingKeySet).toBe(1);
  });

  it("OpenChannel produces 1 Append + 2 WriteOnce per channel", () => {
    const actions: Actions = {
      openChannels: [{ recipient: 0x1n }, { recipient: 0x2n }],
    };
    const counts = estimateServerActionCounts(actions, false);

    expect(counts.append).toBe(2);
    expect(counts.writeOnce).toBe(4);
  });

  it("OpenSubchannel produces 2 WriteOnce per subchannel", () => {
    const actions: Actions = {
      openTokenChannels: [{ recipient: 0x1n, token: 0xan }],
    };
    const counts = estimateServerActionCounts(actions, false);

    expect(counts.writeOnce).toBe(2);
  });

  it("Deposit produces 1 TransferFrom + 1 EmitDeposit", () => {
    const actions: Actions = {
      deposits: [{ token: 0xan, amount: 100n }],
    };
    const counts = estimateServerActionCounts(actions, false);

    expect(counts.transferFrom).toBe(1);
    expect(counts.emitDeposit).toBe(1);
  });

  it("UseNote produces 1 WriteOnce + 1 EmitNoteUsed", () => {
    const actions: Actions = {
      useNotes: [
        {
          token: 0xan,
          note: makeNote(),
        },
      ],
    };
    const counts = estimateServerActionCounts(actions, false);

    expect(counts.writeOnce).toBe(1);
    expect(counts.emitNoteUsed).toBe(1);
  });

  it("CreateNote (encrypted) produces 1 WriteOnce + 1 EmitEncNoteCreated", () => {
    const actions: Actions = {
      createNotes: [{ recipient: 0x1n, token: 0xan, amount: 50n }],
    };
    const counts = estimateServerActionCounts(actions, false);

    expect(counts.writeOnce).toBe(1);
    expect(counts.emitEncNoteCreated).toBe(1);
  });

  it("Withdraw produces 1 TransferTo + 1 EmitWithdrawal (plus fee withdrawal)", () => {
    const actions: Actions = {
      withdraws: [{ recipient: 0x1n, token: 0xan, amount: 50n }],
    };
    const counts = estimateServerActionCounts(actions, false);

    // 1 user withdraw + 1 fee withdrawal
    expect(counts.transferTo).toBe(2);
    expect(counts.emitWithdrawal).toBe(2);
  });
});

describe("estimatePaymasterFee", () => {
  it("empty actions: only baseFee + fee withdrawal cost", () => {
    const fee = estimatePaymasterFee({}, UNIFORM_FEE_SCHEDULE);

    // baseFee(1000) + 1 TransferTo(100) + 1 EmitWithdrawal(100) = 1200
    expect(fee).toBe(1200n);
  });

  it("simple transfer: 1 UseNote + 1 CreateEncNote + fee withdrawal", () => {
    const actions: Actions = {
      useNotes: [
        {
          token: 0xan,
          note: makeNote(),
        },
      ],
      createNotes: [{ recipient: 0x2n, token: 0xan, amount: 50n }],
    };

    const fee = estimatePaymasterFee(actions, UNIFORM_FEE_SCHEDULE);

    // UseNote: 1 WriteOnce(100) + 1 EmitNoteUsed(100) = 200
    // CreateEncNote: 1 WriteOnce(100) + 1 EmitEncNoteCreated(100) = 200
    // Fee withdrawal: 1 TransferTo(100) + 1 EmitWithdrawal(100) = 200
    // Total: 1000 + 200 + 200 + 200 = 1600
    expect(fee).toBe(1600n);
  });

  it("complex tx with setup actions", () => {
    const actions: Actions = {
      setViewingKey: {},
      openChannels: [{ recipient: 0x1n }],
      openTokenChannels: [{ recipient: 0x1n, token: 0xan }],
      deposits: [{ token: 0xan, amount: 100n }],
    };

    const fee = estimatePaymasterFee(actions, UNIFORM_FEE_SCHEDULE);

    // SetViewingKey: 2 WriteOnce(200) + 1 EmitViewingKeySet(100) = 300
    // OpenChannel: 1 Append(100) + 2 WriteOnce(200) = 300
    // OpenSubchannel: 2 WriteOnce(200) = 200
    // Deposit: 1 TransferFrom(100) + 1 EmitDeposit(100) = 200
    // Fee withdrawal: 1 TransferTo(100) + 1 EmitWithdrawal(100) = 200
    // Total: 1000 + 300 + 300 + 200 + 200 + 200 = 2200
    expect(fee).toBe(2200n);
  });

  it("throws for unknown executor address in invoke", () => {
    const actions: Actions = {
      invoke: {
        callBuilder: () => ({
          contractAddress: "0xdead",
          calldata: [],
        }),
      },
    };

    expect(() => estimatePaymasterFee(actions, UNIFORM_FEE_SCHEDULE)).toThrow(
      /Unknown executor address.*gasPrice/
    );
  });

  it("includes invoke cost for known executor", () => {
    const actions: Actions = {
      invoke: {
        callBuilder: () => ({
          contractAddress: "0xbeef",
          calldata: [],
        }),
      },
    };

    const fee = estimatePaymasterFee(actions, UNIFORM_FEE_SCHEDULE);

    // baseFee(1000) + fee withdrawal(200) + invoke(500) = 1700
    expect(fee).toBe(1700n);
  });

  it("uses different per-action rates correctly", () => {
    const differentRates: FeeSchedule = {
      ...UNIFORM_FEE_SCHEDULE,
      baseFee: "500",
      perAction: {
        ...UNIFORM_FEE_SCHEDULE.perAction,
        writeOnce: "10",
        emitNoteUsed: "20",
        transferTo: "30",
        emitWithdrawal: "40",
      },
    };

    const actions: Actions = {
      useNotes: [
        {
          token: 0xan,
          note: makeNote(),
        },
      ],
    };

    const fee = estimatePaymasterFee(actions, differentRates);

    // UseNote: 1 WriteOnce(10) + 1 EmitNoteUsed(20) = 30
    // Fee withdrawal: 1 TransferTo(30) + 1 EmitWithdrawal(40) = 70
    // Total: 500 + 30 + 70 = 600
    expect(fee).toBe(600n);
  });
});
