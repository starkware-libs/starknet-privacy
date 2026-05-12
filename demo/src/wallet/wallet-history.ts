// Wallet-side reclassification of OTC settlement transactions.
//
// The SDK's history classifier doesn't know about OtcSettlement.join_trade —
// it sees the on-chain effect as two private transfers (one outgoing leg + one
// incoming leg) in the same tx. That's correct at the protocol layer but
// misleading in a wallet history, where the user thinks of "I traded with
// Alice", not "I sent and I received from Alice in the same block".
//
// We detect the pattern post-classification: a single transaction whose
// actions contain *both* a transferSent and a transferReceived (with the same
// counterparty). The combination doesn't occur in any other legitimate flow:
// AMM swaps are classified as `type: "swap"` against the executor address;
// a plain send doesn't bundle a receive from the same address in one tx.
//
// We extract the counterparty name from the formatted labels rather than the
// raw addresses because `ActionDisplay` is name-formatted upstream — and
// modifying useHistory.ts to expose addresses would touch the original demo,
// which is off-limits.

import type { ActionDisplay, TransactionDisplay } from "../hooks/useHistory.ts";

export type OtcTradeSummary = {
  counterparty: string;
  /** The user's outgoing leg ("Sent X USD to alice"). */
  sent: ActionDisplay;
  /** The user's incoming leg ("Received Y BTC from alice"). */
  received: ActionDisplay;
};

export function detectOtcTrade(transaction: TransactionDisplay): OtcTradeSummary | null {
  // Skip swap-shaped txs — those are AMM routes and have their own renderer.
  if (transaction.actions.some((action) => action.type === "swap")) return null;

  // The fee action is also a transferSent shape; exclude it so a fee + a real
  // receive doesn't look like a trade.
  const sent = transaction.actions.find(
    (action) => action.type === "transferSent" && !action.isFee
  );
  const received = transaction.actions.find((action) => action.type === "transferReceived");
  if (!sent || !received) return null;

  const sentRecipient = extractCounterparty(sent.label, /\bto\s+(\S+)\s*$/);
  const receivedSender = extractCounterparty(received.label, /\bfrom\s+(\S+)\s*$/);
  if (!sentRecipient || !receivedSender) return null;
  if (sentRecipient.toLowerCase() !== receivedSender.toLowerCase()) return null;

  return { counterparty: sentRecipient, sent, received };
}

function extractCounterparty(label: string, pattern: RegExp): string | null {
  const match = label.match(pattern);
  if (!match) return null;
  return match[1];
}

// Display sugar: the "lead" action and label to render at the head of the row.
// Centralized here so both the Home hero card and the Activity tab agree on
// what an OTC trade should read.
export function leadOtcLabel(summary: OtcTradeSummary): string {
  return `OTC trade with ${summary.counterparty}`;
}
