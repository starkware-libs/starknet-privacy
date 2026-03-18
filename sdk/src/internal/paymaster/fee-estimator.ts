/**
 * Pure function that estimates the paymaster fee from user actions + a rate card.
 *
 * Maps each action type to its expected ServerAction counts (mirroring Cairo's compile_actions),
 * sums baseFee + per-action costs, and includes the fee withdrawal's own cost.
 */

import type { Actions, FeeSchedule } from "../../interfaces.js";
import { toHex } from "../../utils/convert.js";

/**
 * ServerAction type names matching the FeeSchedule.perAction keys.
 */
type ServerActionType =
  | "writeOnce"
  | "append"
  | "transferFrom"
  | "transferTo"
  | "emitViewingKeySet"
  | "emitWithdrawal"
  | "emitDeposit"
  | "emitOpenNoteCreated"
  | "emitEncNoteCreated"
  | "emitNoteUsed";

type ServerActionCounts = Record<ServerActionType, number>;

function emptyCounts(): ServerActionCounts {
  return {
    writeOnce: 0,
    append: 0,
    transferFrom: 0,
    transferTo: 0,
    emitViewingKeySet: 0,
    emitWithdrawal: 0,
    emitDeposit: 0,
    emitOpenNoteCreated: 0,
    emitEncNoteCreated: 0,
    emitNoteUsed: 0,
  };
}

/**
 * Count the ServerActions that the given user actions will produce.
 * Includes the fee withdrawal's own cost (+1 TransferTo, +1 EmitWithdrawal).
 */
export function estimateServerActionCounts(
  actions: Actions,
  includeAutoSetup: boolean
): ServerActionCounts {
  const counts = emptyCounts();

  // SetViewingKey → WriteOnce (pubkey) + WriteOnce (enc privkey) + EmitViewingKeySet
  if (actions.setViewingKey) {
    counts.writeOnce += 2;
    counts.emitViewingKeySet += 1;
  }

  // OpenChannel → Append (enc_channel_info) + WriteOnce (flag) + WriteOnce (outgoing)
  const openChannelCount = actions.openChannels?.length ?? 0;
  counts.append += openChannelCount;
  counts.writeOnce += openChannelCount * 2;

  // OpenSubchannel → WriteOnce (enc subchannel) + WriteOnce (flag)
  const openSubchannelCount = actions.openTokenChannels?.length ?? 0;
  counts.writeOnce += openSubchannelCount * 2;

  // Deposit → TransferFrom + EmitDeposit
  const depositCount = actions.deposits?.length ?? 0;
  counts.transferFrom += depositCount;
  counts.emitDeposit += depositCount;

  // UseNote → WriteOnce (nullifier) + EmitNoteUsed
  const useNoteCount = actions.useNotes?.length ?? 0;
  counts.writeOnce += useNoteCount;
  counts.emitNoteUsed += useNoteCount;

  // CreateNote (encrypted) → WriteOnce (packed_value) + EmitEncNoteCreated
  // CreateNote (open) → WriteOnce (3 felts) + EmitOpenNoteCreated
  if (actions.createNotes) {
    for (const note of actions.createNotes) {
      counts.writeOnce += 1;
      if (typeof note.amount === "symbol") {
        // Open note
        counts.emitOpenNoteCreated += 1;
      } else {
        counts.emitEncNoteCreated += 1;
      }
    }
  }

  // Withdraw → TransferTo + EmitWithdrawal
  const withdrawCount = actions.withdraws?.length ?? 0;
  counts.transferTo += withdrawCount;
  counts.emitWithdrawal += withdrawCount;

  // autoSetup: if enabled, the compiler may implicitly add OpenChannel/OpenSubchannel actions.
  // The caller should account for these by setting includeAutoSetup when applicable.
  // (The actual count depends on registry state at compile time; the estimator cannot know
  // which channels are missing. The caller is responsible for estimating this.)
  if (includeAutoSetup) {
    // Minimal estimate: at least the self-channel subchannels for each unique token in the actions.
    // This is a heuristic — actual cost may vary.
  }

  // Fee withdrawal's own cost: +1 TransferTo + +1 EmitWithdrawal
  counts.transferTo += 1;
  counts.emitWithdrawal += 1;

  return counts;
}

/**
 * Estimate the total paymaster fee for the given actions using the rate card.
 *
 * @param actions - The user's actions (before fee withdrawal injection)
 * @param feeSchedule - The rate card from the paymaster
 * @param includeAutoSetup - Whether to include estimated autoSetup costs
 * @returns Total fee in the fee token's smallest unit
 * @throws If actions include an invoke with an unknown executor address
 */
export function estimatePaymasterFee(
  actions: Actions,
  feeSchedule: FeeSchedule,
  includeAutoSetup = false
): bigint {
  const counts = estimateServerActionCounts(actions, includeAutoSetup);

  let total = BigInt(feeSchedule.baseFee);

  const perAction = feeSchedule.perAction;
  total += BigInt(counts.writeOnce) * BigInt(perAction.writeOnce);
  total += BigInt(counts.append) * BigInt(perAction.append);
  total += BigInt(counts.transferFrom) * BigInt(perAction.transferFrom);
  total += BigInt(counts.transferTo) * BigInt(perAction.transferTo);
  total += BigInt(counts.emitViewingKeySet) * BigInt(perAction.emitViewingKeySet);
  total += BigInt(counts.emitWithdrawal) * BigInt(perAction.emitWithdrawal);
  total += BigInt(counts.emitDeposit) * BigInt(perAction.emitDeposit);
  total += BigInt(counts.emitOpenNoteCreated) * BigInt(perAction.emitOpenNoteCreated);
  total += BigInt(counts.emitEncNoteCreated) * BigInt(perAction.emitEncNoteCreated);
  total += BigInt(counts.emitNoteUsed) * BigInt(perAction.emitNoteUsed);

  // Invoke: look up executor address in the rate card
  if (actions.invoke) {
    // We need to resolve the executor address from the callBuilder.
    // Since callBuilder is a function that takes args, we call it with empty args to get the address.
    const call = actions.invoke.callBuilder({
      openNotes: [],
      withdrawals: [],
      poolAddress: 0n,
    });
    const executorAddress = toHex(call.contractAddress);
    const invokeRate = perAction.invoke[executorAddress];
    if (invokeRate === undefined) {
      throw new Error(
        `Unknown executor address ${executorAddress} — use gasPrice to estimate invoke cost manually`
      );
    }
    total += BigInt(invokeRate);
  }

  return total;
}
