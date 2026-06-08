// Per-chain hint + light-touch validation for destination addresses. We
// intentionally don't fully validate — 1Click rejects invalid addresses with a
// clear error, and tight client-side regex risks rejecting legitimate edge
// cases (e.g., bech32m). We aim to give a hint, not to gate.

export interface AddressShape {
  placeholder: string;
  hint: string;
  /** Returns null on plausible match, or an error string. */
  validate: (s: string) => string | null;
}

function evmShape(chainName: string): AddressShape {
  return {
    placeholder: `0x… (${chainName} address)`,
    hint: `${chainName} EVM address — 0x followed by 40 hex characters`,
    validate: (s) => {
      const t = s.trim();
      if (!t) return null;
      if (!/^0x[0-9a-fA-F]{40}$/.test(t))
        return "Expected an EVM address (0x + 40 hex chars)";
      return null;
    },
  };
}

const BTC_SHAPE: AddressShape = {
  placeholder: "bc1… or 1…/3…",
  hint: "Bitcoin address (bech32 or legacy)",
  validate: (s) => {
    const t = s.trim();
    if (!t) return null;
    if (!/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,80}$/.test(t))
      return "Doesn't look like a Bitcoin address";
    return null;
  },
};

const SOL_SHAPE: AddressShape = {
  placeholder: "Solana address (b58)",
  hint: "Solana base58 address, 32–44 chars",
  validate: (s) => {
    const t = s.trim();
    if (!t) return null;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t))
      return "Doesn't look like a Solana address";
    return null;
  },
};

const TRON_SHAPE: AddressShape = {
  placeholder: "T… (Tron address)",
  hint: "Tron address — starts with T, 34 chars",
  validate: (s) => {
    const t = s.trim();
    if (!t) return null;
    if (!/^T[A-HJ-NP-Za-km-z1-9]{33}$/.test(t))
      return "Doesn't look like a Tron address";
    return null;
  },
};

const GENERIC_SHAPE: AddressShape = {
  placeholder: "Destination address",
  hint: "Destination address",
  validate: () => null,
};

export function shapeForChain(chainTag: string): AddressShape {
  switch (chainTag) {
    case "eth":
      return evmShape("Ethereum");
    case "arb":
      return evmShape("Arbitrum");
    case "base":
      return evmShape("Base");
    case "op":
      return evmShape("Optimism");
    case "pol":
      return evmShape("Polygon");
    case "bsc":
      return evmShape("BSC");
    case "avax":
      return evmShape("Avalanche");
    case "btc":
      return BTC_SHAPE;
    case "sol":
      return SOL_SHAPE;
    case "tron":
      return TRON_SHAPE;
    default:
      return GENERIC_SHAPE;
  }
}
