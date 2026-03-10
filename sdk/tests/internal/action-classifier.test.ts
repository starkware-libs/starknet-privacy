import { describe, it, expect } from "vitest";
import { classifyTransaction } from "../../src/internal/indexer/action-classifier.js";
import type { HistoryTransaction } from "../../src/internal/indexer/history.js";

const STRK = 0x1n;
const ETH = 0x2n;
const ALICE = 0xa11cen;
const BOB = 0xb0bn;
const HELPER = 0xbeefn;

function emptyTransaction(overrides: Partial<HistoryTransaction> = {}): HistoryTransaction {
  return {
    blockNumber: 1,
    transactionHash: 0x100n,
    notes: [],
    deposits: [],
    withdrawals: [],
    openNoteDeposits: [],
    ...overrides,
  };
}

describe("classifyTransaction", () => {
  it("includes blockNumber and transactionHash from the input", () => {
    const result = classifyTransaction(
      emptyTransaction({ blockNumber: 42, transactionHash: 0xabcn })
    );

    expect(result.blockNumber).toBe(42);
    expect(result.transactionHash).toBe(0xabcn);
  });

  it("classifies a pure deposit", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        deposits: [{ userAddress: ALICE, token: STRK, amount: 100n }],
      })
    );

    expect(actions).toEqual([{ type: "deposit", fromAddress: ALICE, token: STRK, amount: 100n }]);
  });

  it("classifies a pure withdrawal", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        withdrawals: [{ toAddress: BOB, token: STRK, amount: 50n }],
      })
    );

    expect(actions).toEqual([{ type: "withdrawal", toAddress: BOB, token: STRK, amount: 50n }]);
  });

  it("classifies an outgoing note as transferSent", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        notes: [
          {
            channelKind: "outgoing",
            token: STRK,
            noteIndex: 0,
            noteId: 1n,
            counterparty: BOB,
            amount: 50n,
            salt: 0n,
          },
        ],
      })
    );

    expect(actions).toEqual([
      { type: "transferSent", toAddress: BOB, token: STRK, amount: 50n, noteCount: 1 },
    ]);
  });

  it("classifies an incoming note as transferReceived", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        notes: [
          {
            channelKind: "incoming",
            token: STRK,
            noteIndex: 0,
            noteId: 1n,
            counterparty: ALICE,
            amount: 50n,
            salt: 0n,
          },
        ],
      })
    );

    expect(actions).toEqual([
      { type: "transferReceived", fromAddress: ALICE, token: STRK, amount: 50n, noteCount: 1 },
    ]);
  });

  it("classifies a single-leg swap", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        withdrawals: [{ toAddress: HELPER, token: STRK, amount: 10n }],
        openNoteDeposits: [{ depositor: HELPER, token: ETH, noteId: 1n, amount: 20n }],
      })
    );

    expect(actions).toEqual([
      {
        type: "swap",
        executor: HELPER,
        sent: [{ token: STRK, amount: 10n }],
        received: [{ token: ETH, amount: 20n }],
      },
    ]);
  });

  it("classifies a multi-leg swap", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        withdrawals: [
          { toAddress: HELPER, token: STRK, amount: 10n },
          { toAddress: HELPER, token: ETH, amount: 5n },
        ],
        openNoteDeposits: [{ depositor: HELPER, token: STRK, noteId: 1n, amount: 30n }],
      })
    );

    expect(actions).toEqual([
      {
        type: "swap",
        executor: HELPER,
        sent: [
          { token: STRK, amount: 10n },
          { token: ETH, amount: 5n },
        ],
        received: [{ token: STRK, amount: 30n }],
      },
    ]);
  });

  it("skips self_channel notes", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        notes: [
          {
            channelKind: "self_channel",
            token: STRK,
            noteIndex: 0,
            noteId: 1n,
            counterparty: ALICE,
            amount: 50n,
            salt: 0n,
          },
        ],
      })
    );

    expect(actions).toEqual([]);
  });

  it("classifies deposit + transfer (self_channel ignored)", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        deposits: [{ userAddress: ALICE, token: STRK, amount: 100n }],
        notes: [
          {
            channelKind: "outgoing",
            token: STRK,
            noteIndex: 0,
            noteId: 1n,
            counterparty: BOB,
            amount: 50n,
            salt: 0n,
          },
          {
            channelKind: "self_channel",
            token: STRK,
            noteIndex: 0,
            noteId: 2n,
            counterparty: ALICE,
            amount: 50n,
            salt: 0n,
          },
        ],
      })
    );

    expect(actions).toEqual([
      { type: "deposit", fromAddress: ALICE, token: STRK, amount: 100n },
      { type: "transferSent", toAddress: BOB, token: STRK, amount: 50n, noteCount: 1 },
    ]);
  });

  it("aggregates multiple notes with same kind/counterparty/token", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        notes: [
          {
            channelKind: "outgoing",
            token: STRK,
            noteIndex: 0,
            noteId: 1n,
            counterparty: BOB,
            amount: 25n,
            salt: 0n,
          },
          {
            channelKind: "outgoing",
            token: STRK,
            noteIndex: 1,
            noteId: 2n,
            counterparty: BOB,
            amount: 25n,
            salt: 0n,
          },
        ],
      })
    );

    expect(actions).toEqual([
      { type: "transferSent", toAddress: BOB, token: STRK, amount: 50n, noteCount: 2 },
    ]);
  });

  it("returns empty actions for empty transaction", () => {
    const { actions } = classifyTransaction(emptyTransaction());
    expect(actions).toEqual([]);
  });

  it("classifies openNoteDeposit without matching withdrawal as swap with empty sent", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        openNoteDeposits: [{ depositor: HELPER, token: ETH, noteId: 1n, amount: 20n }],
      })
    );

    expect(actions).toEqual([
      {
        type: "swap",
        executor: HELPER,
        sent: [],
        received: [{ token: ETH, amount: 20n }],
      },
    ]);
  });

  it("classifies withdrawal without openNoteDeposit as plain withdrawal", () => {
    const { actions } = classifyTransaction(
      emptyTransaction({
        withdrawals: [{ toAddress: BOB, token: STRK, amount: 50n }],
      })
    );

    expect(actions).toEqual([{ type: "withdrawal", toAddress: BOB, token: STRK, amount: 50n }]);
  });
});
