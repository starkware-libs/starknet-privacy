import type { HistoryTransaction, HistoryNote } from "./history.js";

export type SwapLeg = {
  token: bigint;
  amount: bigint;
};

export type HistoryAction =
  | { type: "deposit"; fromAddress: bigint; token: bigint; amount: bigint }
  | { type: "withdrawal"; toAddress: bigint; token: bigint; amount: bigint }
  | { type: "transferSent"; toAddress: bigint; token: bigint; amount: bigint; noteCount: number }
  | {
      type: "transferReceived";
      fromAddress: bigint;
      token: bigint;
      amount: bigint;
      noteCount: number;
    }
  | { type: "swap"; executor: bigint; sent: SwapLeg[]; received: SwapLeg[] };

export type HistoryActionKind = HistoryAction["type"];

export type ClassifiedTransaction = {
  blockNumber: number;
  transactionHash: bigint;
  actions: HistoryAction[];
};

/** Classifies a history transaction's raw events into user-facing actions. Pure, no I/O. */
export function classifyTransaction(transaction: HistoryTransaction): ClassifiedTransaction {
  const actions: HistoryAction[] = [];

  // Step 1: Detect swaps — openNoteDeposits are swap received legs, grouped by depositor (executor).
  // Withdrawals matching an executor's address become the swap's sent legs.
  const swapsByExecutor = new Map<bigint, { sent: SwapLeg[]; received: SwapLeg[] }>();
  const matchedWithdrawalIndexes = new Set<number>();

  for (const openNoteDeposit of transaction.openNoteDeposits) {
    let swap = swapsByExecutor.get(openNoteDeposit.depositor);
    if (!swap) {
      swap = { sent: [], received: [] };
      swapsByExecutor.set(openNoteDeposit.depositor, swap);
    }
    swap.received.push({ token: openNoteDeposit.token, amount: openNoteDeposit.amount });
  }

  for (const [executor, swap] of swapsByExecutor) {
    for (let index = 0; index < transaction.withdrawals.length; index++) {
      if (matchedWithdrawalIndexes.has(index)) continue;
      if (transaction.withdrawals[index].toAddress === executor) {
        const withdrawal = transaction.withdrawals[index];
        swap.sent.push({ token: withdrawal.token, amount: withdrawal.amount });
        matchedWithdrawalIndexes.add(index);
      }
    }
    actions.push({ type: "swap", executor, sent: swap.sent, received: swap.received });
  }

  // Step 2: Classify deposits and remaining withdrawals
  for (const deposit of transaction.deposits) {
    actions.push({
      type: "deposit",
      fromAddress: deposit.userAddress,
      token: deposit.token,
      amount: deposit.amount,
    });
  }

  for (let index = 0; index < transaction.withdrawals.length; index++) {
    if (matchedWithdrawalIndexes.has(index)) continue;
    const withdrawal = transaction.withdrawals[index];
    actions.push({
      type: "withdrawal",
      toAddress: withdrawal.toAddress,
      token: withdrawal.token,
      amount: withdrawal.amount,
    });
  }

  // Step 3: Classify notes — aggregate by (channelKind, counterparty, token)
  const noteAggregates = new Map<
    string,
    { note: HistoryNote; totalAmount: bigint; noteCount: number }
  >();

  for (const note of transaction.notes) {
    if (note.channelKind === "self_channel") continue;
    const aggregateKey = `${note.channelKind}:${note.counterparty}:${note.token}`;
    const existing = noteAggregates.get(aggregateKey);
    if (existing) {
      existing.totalAmount += note.amount;
      existing.noteCount += 1;
    } else {
      noteAggregates.set(aggregateKey, { note, totalAmount: note.amount, noteCount: 1 });
    }
  }

  for (const { note, totalAmount, noteCount } of noteAggregates.values()) {
    if (note.channelKind === "outgoing") {
      actions.push({
        type: "transferSent",
        toAddress: note.counterparty,
        token: note.token,
        amount: totalAmount,
        noteCount,
      });
    } else {
      actions.push({
        type: "transferReceived",
        fromAddress: note.counterparty,
        token: note.token,
        amount: totalAmount,
        noteCount,
      });
    }
  }

  return {
    blockNumber: transaction.blockNumber,
    transactionHash: transaction.transactionHash,
    actions,
  };
}
