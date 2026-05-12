// Shareable OTC trade "card" — a JSON blob the originator copies and the
// counterparty pastes to prefill the opposite legs.
//
// Mirroring is done at COPY time, not paste time: the JSON describes the
// form state from the *recipient's* perspective. That way, when the
// counterparty pastes, they see "you offer X, you receive Y" and the
// counterparty field already points at the originator's address.
//
// Wire format (versioned for forward-compat):
//
//   {
//     "kind": "veil-otc-trade",
//     "version": 1,
//     "tradeId": "0x...",
//     "from": { "address": "0x...", "name": "Alice" },
//     "offer": { "token": "0x...", "tokenName": "USD", "amount": "100" },
//     "ask":   { "token": "0x...", "tokenName": "BTC", "amount": "0.01" }
//   }

export type TradeCard = {
  tradeId: string;
  from: { address: string; name?: string };
  offer: { token: string; tokenName?: string; amount: string };
  ask: { token: string; tokenName?: string; amount: string };
};

type WireFormat = {
  kind: "veil-otc-trade";
  version: 1;
} & TradeCard;

const KIND = "veil-otc-trade";
const VERSION = 1;

// Build the JSON to share. Caller passes their *own* form state; this function
// mirrors offer↔ask so the resulting card matches the counterparty's view.
export function encodeTradeCard(input: {
  tradeId: string;
  myAddress: string;
  myName?: string;
  myOffer: { token: string; tokenName?: string; amount: string };
  myAsk: { token: string; tokenName?: string; amount: string };
}): string {
  const card: WireFormat = {
    kind: KIND,
    version: VERSION,
    tradeId: input.tradeId,
    from: { address: input.myAddress, name: input.myName },
    // Mirror: what *I* offer is what *they* receive, so it goes into their `ask`.
    offer: input.myAsk,
    ask: input.myOffer,
  };
  return JSON.stringify(card, null, 2);
}

// Parse a pasted card. Returns the trade details from the *receiver's*
// perspective (no further mirroring needed — already done at encode time).
//
// Liberal in what it accepts: tolerates extra whitespace, wrapping characters
// (so a user can paste a code block or chat bubble), and missing optional
// fields. Strict on the discriminator + required string fields so a random
// JSON object pasted by mistake fails cleanly.
export function decodeTradeCard(raw: string): TradeCard | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Empty input" };

  // Strip common wrapping (triple-backtick code fences, surrounding quotes).
  const unwrapped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    return { error: "Not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { error: "Expected a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== KIND) {
    return { error: 'Not a "veil-otc-trade" card' };
  }
  if (obj.version !== VERSION) {
    return { error: `Unsupported card version: ${String(obj.version)}` };
  }

  const tradeId = obj.tradeId;
  const from = obj.from as Record<string, unknown> | undefined;
  const offer = obj.offer as Record<string, unknown> | undefined;
  const ask = obj.ask as Record<string, unknown> | undefined;

  if (typeof tradeId !== "string") return { error: "Missing tradeId" };
  if (!from || typeof from.address !== "string") return { error: "Missing from.address" };
  if (!offer || typeof offer.token !== "string" || typeof offer.amount !== "string") {
    return { error: "Missing offer.token / offer.amount" };
  }
  if (!ask || typeof ask.token !== "string" || typeof ask.amount !== "string") {
    return { error: "Missing ask.token / ask.amount" };
  }

  return {
    tradeId,
    from: {
      address: from.address,
      name: typeof from.name === "string" ? from.name : undefined,
    },
    offer: {
      token: offer.token,
      tokenName: typeof offer.tokenName === "string" ? offer.tokenName : undefined,
      amount: offer.amount,
    },
    ask: {
      token: ask.token,
      tokenName: typeof ask.tokenName === "string" ? ask.tokenName : undefined,
      amount: ask.amount,
    },
  };
}
